/**
 * IncomePM — Backend Server
 * ─────────────────────────────────────────────────────────────────
 * Handles:
 *  • Real withdrawals via Flutterwave Transfer API (NIBSS/NIP)
 *  • Deposit verification via Flutterwave Verify Transaction API
 *  • Earnings ledger (₦200/minute per active investment)
 *  • Webhook receiver for transfer & payment events
 * ─────────────────────────────────────────────────────────────────
 * Deploy on: Render · Railway · Heroku
 */

const express   = require('express');
const axios     = require('axios');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan    = require('morgan');
const crypto    = require('crypto');

const app  = express();
const PORT = process.env.PORT || 4000;

// ─── KEYS & CONFIG ─────────────────────────────────────────────────────────
const FLW_SECRET_KEY   = process.env.FLW_SECRET_KEY   || 'FLWSECK-68be972b3926b06d87bdd65f6c806447-19f6591a5d6vt-X';
const FLW_PUBLIC_KEY   = process.env.FLW_PUBLIC_KEY   || 'FLWPUBK-31cfd58f509f25112471a165b6efd9b8-X';
const FLW_WEBHOOK_HASH = process.env.FLW_WEBHOOK_HASH || 'incomepm-webhook-hash-2026';
const FLW_BASE         = 'https://api.flutterwave.com/v3';

const EARN_RATE        = 200;   // ₦200 per minute
const MIN_INVEST       = 2000;  // ₦2,000
const MAX_INVEST       = 50000; // ₦50,000
const MIN_WITHDRAW     = 500;   // ₦500

// ─── IN-MEMORY INVESTMENT LEDGER ────────────────────────────────────────────
// In production replace with a database (PostgreSQL, MongoDB, etc.)
const investors = {};
// NairaSpinWheel withdrawal status store (keyed by reference)
const nswWithdrawals = {};
// Structure: investors[userId] = {
//   userId, name, phone, email,
//   totalInvested, wallet, totalEarned, totalWithdrawn,
//   investStart (timestamp ms), minutesActive,
//   transactions: [],
//   active: bool
// }

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
}));

const withdrawLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max     : 10,
  message : { success: false, message: 'Too many requests. Please wait 15 minutes.' },
});

// ─── NIGERIAN BANK CODES ────────────────────────────────────────────────────
const BANK_CODES = {
  'Access Bank'            : '044',
  'GTBank'                 : '058',
  'First Bank of Nigeria'  : '011',
  'Zenith Bank'            : '057',
  'UBA'                    : '033',
  'United Bank For Africa' : '033',
  'Fidelity Bank'          : '070',
  'Union Bank'             : '032',
  'Sterling Bank'          : '232',
  'Stanbic IBTC'           : '221',
  'FCMB'                   : '214',
  'Ecobank Nigeria'        : '050',
  'Keystone Bank'          : '082',
  'Polaris Bank'           : '076',
  'Wema Bank'              : '035',
  'Heritage Bank'          : '030',
  'Opay'                   : '100004',
  'Kuda Bank'              : '50211',
  'PalmPay'                : '100033',
  'Moniepoint'             : '50515',
  'Flutterwave MFB'        : '110005',
  'Indulge MFB'            : '50992',
};

// ─── HELPERS ───────────────────────────────────────────────────────────
function getBankCode(name) {
  if (!name) return null;
  if (BANK_CODES[name]) return BANK_CODES[name];
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(BANK_CODES)) {
    if (lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower)) return v;
  }
  return null;
}

function generateRef(prefix = 'IPM') {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function maskAcct(n)  { return '******' + String(n).slice(-4); }
function maskPhone(p) { return String(p).slice(0,4) + '****' + String(p).slice(-3); }

function buildSMS(firstName, amount, bank, maskedAcct, ref) {
  return (
    `Dear ${firstName}, ₦${Number(amount).toLocaleString('en-NG')} has been sent ` +
    `to your ${bank} account ${maskedAcct}. Ref: ${ref}. ` +
    `Arrives within 5 mins via NIBSS/NIP. - IncomePM`
  );
}

function nowISO() { return new Date().toISOString(); }

function calcEarnings(investor) {
  if (!investor.active || !investor.investStart) return 0;
  const elapsedMs  = Date.now() - investor.investStart;
  const totalMins  = Math.floor(elapsedMs / 60000);
  const uncredited = totalMins - investor.minutesActive;
  return uncredited > 0 ? uncredited * EARN_RATE : 0;
}

function getOrCreateInvestor(userId, defaults = {}) {
  if (!investors[userId]) {
    investors[userId] = {
      userId,
      name           : defaults.name   || 'Investor',
      phone          : defaults.phone  || '',
      email          : defaults.email  || '',
      totalInvested  : 0,
      wallet         : 0,
      totalEarned    : 0,
      totalWithdrawn : 0,
      investStart    : null,
      minutesActive  : 0,
      active         : false,
      transactions   : [],
      createdAt      : nowISO(),
    };
  }
  return investors[userId];
}

function creditPendingEarnings(inv) {
  const pending = calcEarnings(inv);
  if (pending > 0) {
    inv.wallet        += pending;
    inv.totalEarned   += pending;
    const mins = Math.floor(pending / EARN_RATE);
    inv.minutesActive += mins;
    inv.transactions.push({
      id       : generateRef('EARN'),
      type     : 'earn',
      amount   : pending,
      direction: 'credit',
      desc     : `${mins} minute earnings @ ₦200/min`,
      status   : 'success',
      ts       : nowISO(),
    });
  }
  return pending;
}

// ─── GUARD — log warning if key somehow missing ──────────────────────────────
app.use((req, res, next) => {
  const open = ['/health', '/banks', '/earnings'];
  if (open.some(p => req.path.startsWith(p))) return next();
  if (!FLW_SECRET_KEY) {
    console.error('⚠️  FLW_SECRET_KEY is not set. Check server configuration.');
    return res.status(503).json({
      success: false,
      message: 'Server configuration error. Please contact support.',
    });
  }
  next();
});

// ═════════════════════════════════════════════════════════════════
//  ROUTES
// ═════════════════════════════════════════════════════════════════

// GET /health
app.get('/health', (req, res) => {
  res.json({
    status   : 'ok',
    service  : 'IncomePM Transfer & Earnings Server',
    version  : '1.0.0',
    timestamp: nowISO(),
    ready    : !!FLW_SECRET_KEY,
    investors: Object.keys(investors).length,
  });
});

// GET /ip — show server outbound IP (needed for Flutterwave IP whitelisting)
app.get('/ip', async (req, res) => {
  const services = [
    'https://api.ipify.org?format=json',
    'https://api.my-ip.io/ip.json',
    'https://ipinfo.io/json',
    'https://api4.my-ip.io/ip.json',
    'https://checkip.amazonaws.com',
  ];

  for (const url of services) {
    try {
      const { data } = await axios.get(url, { timeout: 5000 });
      // Different services return different formats
      const ip =
        (typeof data === 'string' ? data.trim() : null) ||
        data.ip ||
        data.IPv4 ||
        data.query ||
        null;

      if (ip && ip.length > 5) {
        return res.json({
          success     : true,
          server_ip   : ip,
          ip_version  : ip.includes(':') ? 'IPv6' : 'IPv4',
          source      : url,
          message     : 'Copy this IP and add it to Flutterwave dashboard → Settings → API → Whitelisted IPs',
          dashboard   : 'https://dashboard.flutterwave.com/settings/apis',
          next_step   : `Go to Flutterwave dashboard → Settings → API Keys → Whitelist IP → paste: ${ip}`,
        });
      }
    } catch (e) {
      console.warn(`[ip] Failed: ${url} — ${e.message}`);
      continue;
    }
  }

  // Final fallback — use request headers (works behind proxies/load balancers)
  const headerIP =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    null;

  if (headerIP) {
    return res.json({
      success     : true,
      server_ip   : headerIP,
      ip_version  : headerIP.includes(':') ? 'IPv6' : 'IPv4',
      source      : 'request-headers',
      note        : 'IP detected from request headers. This may be your load balancer IP.',
      message     : 'Copy this IP and add it to Flutterwave dashboard → Settings → API → Whitelisted IPs',
      dashboard   : 'https://dashboard.flutterwave.com/settings/apis',
    });
  }

  // If all fail — return server info so you can check manually
  return res.status(200).json({
    success  : false,
    message  : 'Could not auto-detect IP. Check Render dashboard for your server IP.',
    how_to_find: [
      '1. Go to render.com → Your service → Settings',
      '2. Look for "Outbound IPs" section',
      '3. Copy the IP shown there',
      '4. Paste it in Flutterwave → Settings → API → Whitelisted IPs',
    ],
    render_dashboard : 'https://dashboard.render.com',
    flw_dashboard    : 'https://dashboard.flutterwave.com/settings/apis',
    headers_received : {
      forwarded : req.headers['x-forwarded-for'] || 'none',
      real_ip   : req.headers['x-real-ip']       || 'none',
      remote    : req.socket?.remoteAddress       || 'none',
    },
  });
});

// GET / — root homepage with full API directory
app.get('/', (req, res) => {
  res.json({
    success : true,
    service : 'IncomePM — Backend Server',
    version : '1.0.0',
    status  : 'running',
    ready   : !!FLW_SECRET_KEY,
    timestamp: nowISO(),
    earn_rate: `₦${EARN_RATE} per minute`,
    routes  : {
      'GET  /ip'                       : 'Get server outbound IPv4 for Flutterwave whitelisting',
      'GET  /health'                  : 'Server health & readiness check',
      'GET  /banks'                   : 'List all supported Nigerian banks',
      'POST /invest/confirm'          : 'Activate earnings after Flutterwave deposit',
      'POST /invest/activate-manual'  : 'Activate earnings after bank transfer deposit',
      'GET  /earnings/:user_id'       : 'Get live earnings & wallet balance',
      'POST /verify-account'          : 'Verify Nigerian bank account before withdrawal',
      'POST /withdraw'                : 'Withdraw NGN to Nigerian bank (NIBSS/NIP)',
      'POST /withdraw/status'         : 'Check transfer status by reference',
      'GET  /transactions/:user_id'   : 'Full transaction history for a user',
      'POST /webhook'                 : '⚡ UNIFIED webhook — handles IncomePM (IPM-) + NairaSpinWheel (NSW-)',
    },
    test_urls: {
      homepage    : `${req.protocol}://${req.get('host')}/`,
      health      : `${req.protocol}://${req.get('host')}/health`,
      banks       : `${req.protocol}://${req.get('host')}/banks`,
      server_ip   : `${req.protocol}://${req.get('host')}/ip`,
      earnings    : `${req.protocol}://${req.get('host')}/earnings/user-001`,
    },
  });
});

// GET /banks
app.get('/banks', (req, res) => {
  res.json({ success: true, banks: Object.keys(BANK_CODES) });
});

// ─────────────────────────────────────────────────────────────────
// POST /invest/confirm
// Called after a successful Flutterwave deposit to activate earnings
// Body: { user_id, transaction_id, name, email, phone }
// ─────────────────────────────────────────────────────────────────
app.post('/invest/confirm', async (req, res) => {
  const { user_id, transaction_id, name, email, phone } = req.body;

  if (!user_id)        return res.status(400).json({ success: false, message: 'user_id is required.' });
  if (!transaction_id) return res.status(400).json({ success: false, message: 'transaction_id is required.' });

  // Verify payment with Flutterwave
  try {
    const { data } = await axios.get(
      `${FLW_BASE}/transactions/${transaction_id}/verify`,
      { headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` } }
    );

    if (data.status !== 'success' || data.data.status !== 'successful') {
      return res.status(422).json({
        success: false,
        message: 'Payment not verified by Flutterwave.',
        status : data.data?.status,
      });
    }

    const amount   = data.data.amount;
    const currency = data.data.currency;

    if (currency !== 'NGN') {
      return res.status(422).json({ success: false, message: 'Only NGN deposits are accepted.' });
    }
    if (amount < MIN_INVEST) {
      return res.status(422).json({ success: false, message: `Minimum investment is ₦${MIN_INVEST.toLocaleString()}.` });
    }
    if (amount > MAX_INVEST) {
      return res.status(422).json({ success: false, message: `Maximum investment is ₦${MAX_INVEST.toLocaleString()}.` });
    }

    const inv = getOrCreateInvestor(user_id, { name, email, phone });

    // Credit deposit & activate earnings
    inv.totalInvested += amount;
    if (!inv.active) {
      inv.active      = true;
      inv.investStart = inv.investStart || Date.now();
    }
    inv.transactions.push({
      id       : generateRef('DEP'),
      type     : 'deposit',
      amount,
      direction: 'credit',
      desc     : `Investment deposit via Flutterwave`,
      flw_ref  : data.data.flw_ref,
      tx_ref   : data.data.tx_ref,
      status   : 'success',
      ts       : nowISO(),
    });

    return res.json({
      success       : true,
      message       : `₦${amount.toLocaleString()} invested. Earning ₦${EARN_RATE}/min starting now!`,
      user_id,
      amount_invested: amount,
      total_invested : inv.totalInvested,
      earn_rate      : `₦${EARN_RATE} per minute`,
      per_hour       : `₦${EARN_RATE * 60}`,
      per_day        : `₦${EARN_RATE * 60 * 24}`,
      active         : inv.active,
      invest_start   : new Date(inv.investStart).toISOString(),
    });

  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('[invest/confirm] Error:', msg);
    return res.status(500).json({ success: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /invest/activate-manual
// For bank transfer deposits — activate manually after confirmation
// Body: { user_id, amount, reference, name, email, phone }
// ─────────────────────────────────────────────────────────────────
app.post('/invest/activate-manual', async (req, res) => {
  const { user_id, amount, reference, name, email, phone } = req.body;

  if (!user_id)   return res.status(400).json({ success: false, message: 'user_id is required.' });
  if (!amount)    return res.status(400).json({ success: false, message: 'amount is required.' });
  if (!reference) return res.status(400).json({ success: false, message: 'reference is required.' });

  const amt = Number(amount);
  if (amt < MIN_INVEST) return res.status(400).json({ success: false, message: `Minimum investment is ₦${MIN_INVEST.toLocaleString()}.` });
  if (amt > MAX_INVEST) return res.status(400).json({ success: false, message: `Maximum investment is ₦${MAX_INVEST.toLocaleString()}.` });

  const inv = getOrCreateInvestor(user_id, { name, email, phone });
  inv.totalInvested += amt;
  if (!inv.active) {
    inv.active      = true;
    inv.investStart = inv.investStart || Date.now();
  }
  inv.transactions.push({
    id       : reference,
    type     : 'deposit',
    amount   : amt,
    direction: 'credit',
    desc     : 'Bank Transfer Investment (UBA)',
    status   : 'success',
    ts       : nowISO(),
  });

  return res.json({
    success        : true,
    message        : `₦${amt.toLocaleString()} investment activated via bank transfer.`,
    user_id,
    amount_invested: amt,
    total_invested : inv.totalInvested,
    earn_rate      : `₦${EARN_RATE} per minute`,
    per_hour       : `₦${EARN_RATE * 60}`,
    per_day        : `₦${EARN_RATE * 60 * 24}`,
    active         : inv.active,
    invest_start   : new Date(inv.investStart).toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────
// GET /earnings/:user_id
// Returns current earnings, wallet balance and investment status
// ─────────────────────────────────────────────────────────────────
app.get('/earnings/:user_id', (req, res) => {
  const inv = investors[req.params.user_id];
  if (!inv) {
    return res.json({
      success      : true,
      active       : false,
      wallet       : 0,
      totalEarned  : 0,
      totalInvested: 0,
      message      : 'No active investment found.',
    });
  }

  // Credit any pending earnings before responding
  const credited = creditPendingEarnings(inv);

  return res.json({
    success          : true,
    user_id          : inv.userId,
    active           : inv.active,
    wallet           : inv.wallet,
    total_invested   : inv.totalInvested,
    total_earned     : inv.totalEarned,
    total_withdrawn  : inv.totalWithdrawn,
    minutes_active   : inv.minutesActive,
    earn_rate        : `₦${EARN_RATE} per minute`,
    per_hour         : `₦${EARN_RATE * 60}`,
    per_day          : `₦${EARN_RATE * 60 * 24}`,
    just_credited    : credited,
    invest_start     : inv.investStart ? new Date(inv.investStart).toISOString() : null,
    last_updated     : nowISO(),
  });
});

// ─────────────────────────────────────────────────────────────────
// POST /verify-account
// Verify a bank account number before processing withdrawal
// Body: { account_number, bank_name }
// ─────────────────────────────────────────────────────────────────
app.post('/verify-account', async (req, res) => {
  const { account_number, bank_name } = req.body;
  if (!account_number || !bank_name)
    return res.status(400).json({ success: false, message: 'account_number and bank_name are required.' });

  const bankCode = getBankCode(bank_name);
  if (!bankCode)
    return res.status(400).json({ success: false, message: `Bank "${bank_name}" is not supported.` });

  try {
    const { data } = await axios.get(
      `${FLW_BASE}/accounts/resolve`,
      { params: { account_number, account_bank: bankCode }, headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` } }
    );

    if (data.status === 'success') {
      return res.json({
        success       : true,
        account_name  : data.data.account_name,
        account_number: data.data.account_number,
        bank_code     : bankCode,
        bank_name,
      });
    }
    return res.status(422).json({ success: false, message: data.message || 'Could not verify account.' });

  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('[verify-account]', msg);
    return res.status(500).json({ success: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /withdraw
// Initiate a real Flutterwave NIBSS/NIP transfer
// Body: { user_id, bank_name, account_number, account_name,
//         amount, phone }
// ─────────────────────────────────────────────────────────────────
app.post('/withdraw', withdrawLimiter, async (req, res) => {
  const { user_id, bank_name, account_number, account_name, amount, phone } = req.body;

  if (!user_id)        return res.status(400).json({ success: false, message: 'user_id is required.' });
  if (!bank_name)      return res.status(400).json({ success: false, message: 'bank_name is required.' });
  if (!account_number) return res.status(400).json({ success: false, message: 'account_number is required.' });
  if (!account_name)   return res.status(400).json({ success: false, message: 'account_name is required.' });
  if (!amount)         return res.status(400).json({ success: false, message: 'amount is required.' });
  if (!phone)          return res.status(400).json({ success: false, message: 'phone is required.' });

  const numAmt = Number(amount);
  if (isNaN(numAmt) || numAmt < MIN_WITHDRAW)
    return res.status(400).json({ success: false, message: `Minimum withdrawal is ₦${MIN_WITHDRAW}.` });

  const bankCode = getBankCode(bank_name);
  if (!bankCode)
    return res.status(400).json({ success: false, message: `Bank "${bank_name}" is not supported.` });

  const inv = investors[user_id];

  // Credit any pending earnings first
  if (inv) creditPendingEarnings(inv);

  const availableBalance = inv ? inv.wallet : 0;
  if (numAmt > availableBalance) {
    return res.status(400).json({
      success  : false,
      message  : `Insufficient balance. Available: ₦${availableBalance.toLocaleString('en-NG')}.`,
      available: availableBalance,
    });
  }

  const txRef      = generateRef('IPM-WDR');
  const maskedAcct = maskAcct(account_number);
  const firstName  = String(account_name).split(' ')[0];
  const smsText    = buildSMS(firstName, numAmt, bank_name, maskedAcct, txRef);

  const payload = {
    account_bank   : bankCode,
    account_number : String(account_number).trim(),
    amount         : numAmt,
    narration      : `IncomePM earnings withdrawal`,
    currency       : 'NGN',
    reference      : txRef,
    callback_url   : process.env.WEBHOOK_URL || '',
    debit_currency : 'NGN',
    meta           : [{
      AccountNumber  : String(account_number).trim(),
      RoutingNumber  : bankCode,
      SwiftCode      : '',
      BankName       : bank_name,
      BeneficiaryName: account_name,
      Mobile         : phone,
    }],
  };

  try {
    const { data } = await axios.post(
      `${FLW_BASE}/transfers`,
      payload,
      { headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, 'Content-Type': 'application/json' } }
    );

    const initiated =
      data.status === 'success' ||
      data.data?.status === 'NEW' ||
      data.data?.status === 'PENDING';

    if (initiated) {
      // Deduct from wallet
      if (inv) {
        inv.wallet         -= numAmt;
        inv.totalWithdrawn += numAmt;
        inv.transactions.push({
          id       : txRef,
          type     : 'withdraw',
          amount   : numAmt,
          direction: 'debit',
          desc     : `Withdrawal to ${bank_name}`,
          bank     : bank_name,
          account  : maskedAcct,
          status   : 'processing',
          ts       : nowISO(),
        });
      }

      const now     = new Date();
      const timeStr = now.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      return res.json({
        success      : true,
        message      : 'Transfer initiated via NIBSS/NIP. Arrives within 1–10 minutes.',
        reference    : txRef,
        flw_ref      : data.data?.id || data.data?.reference || null,
        amount       : numAmt,
        bank         : bank_name,
        account      : maskedAcct,
        status       : data.data?.status || 'PENDING',
        time         : timeStr,
        phone_masked : maskPhone(phone),
        sms_alert    : smsText,
        remaining_balance: inv ? inv.wallet : 0,
        eta          : 'Arrives within 1–10 minutes via NIBSS/NIP',
      });
    }

    return res.status(422).json({
      success: false,
      message: data.message || 'Transfer could not be initiated.',
      raw    : data,
    });

  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    console.error('[withdraw] Error:', errMsg, err.response?.data);
    return res.status(500).json({ success: false, message: 'Transfer failed: ' + errMsg });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /withdraw/status
// Check transfer status by reference
// Body: { reference }
// ─────────────────────────────────────────────────────────────────
app.post('/withdraw/status', async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ success: false, message: 'reference is required.' });

  try {
    const { data } = await axios.get(
      `${FLW_BASE}/transfers`,
      { params: { reference }, headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` } }
    );

    const t = data.data?.[0] || data.data;
    if (t) {
      return res.json({
        success  : true,
        reference: t.reference,
        status   : t.status,
        amount   : t.amount,
        bank     : t.bank_name || t.account_bank,
        account  : maskAcct(t.account_number),
        created  : t.created_at,
        complete : t.status === 'SUCCESSFUL',
      });
    }
    return res.status(404).json({ success: false, message: 'Transfer not found.' });

  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('[withdraw/status]', msg);
    return res.status(500).json({ success: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /transactions/:user_id
// Returns full transaction history for a user
// ─────────────────────────────────────────────────────────────────
app.get('/transactions/:user_id', (req, res) => {
  const inv = investors[req.params.user_id];
  if (!inv) return res.json({ success: true, transactions: [] });
  return res.json({
    success     : true,
    user_id     : inv.userId,
    transactions: inv.transactions.slice(0, 100),
    total       : inv.transactions.length,
  });
});

// ─────────────────────────────────────────────────────────────────
// POST /webhook
// ─── UNIFIED WEBHOOK — handles IncomePM + NairaSpinWheel ─────────
// Both apps share the same Flutterwave account.
// Routes by reference prefix: IPM- = IncomePM, NSW- = NairaSpinWheel
// ─────────────────────────────────────────────────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['verif-hash'];
  if (FLW_WEBHOOK_HASH && signature !== FLW_WEBHOOK_HASH) {
    console.warn('[webhook] Invalid signature — rejected');
    return res.status(401).json({ message: 'Invalid signature' });
  }

  let event;
  try { event = JSON.parse(req.body); } catch (e) { event = req.body; }

  const type = event.event;
  const d    = event.data;
  const ref  = d?.reference || d?.tx_ref || '';

  // ── Detect which app this event belongs to ───────────────────
  const isIncomePM      = ref.startsWith('IPM-');
  const isNairaSpinWheel = ref.startsWith('NSW-') || ref.startsWith('SPT-');
  const appName = isIncomePM ? 'IncomePM' : isNairaSpinWheel ? 'NairaSpinWheel' : 'Unknown';

  console.log(`\n[webhook] ── ${appName} ── Event: ${type} | Ref: ${ref}`);
  console.log(`[webhook] Data:`, JSON.stringify(d, null, 2));

  // ── TRANSFER EVENTS (withdrawals) ────────────────────────────
  if (type === 'transfer.completed') {
    if (d.status === 'SUCCESSFUL') {
      console.log(`✅ [${appName}] Transfer SUCCESSFUL ₦${d.amount} → ${d.account_number} (${d.bank_name}) Ref: ${ref}`);

      if (isIncomePM) {
        // Mark withdrawal as complete in IncomePM investor records
        for (const inv of Object.values(investors)) {
          const tx = inv.transactions.find(t => t.id === ref);
          if (tx) {
            tx.status       = 'success';
            tx.completed_at = nowISO();
            console.log(`💰 [IncomePM] Marked withdrawal complete for investor ${inv.userId}`);
          }
        }
      }

      if (isNairaSpinWheel) {
        // NairaSpinWheel withdrawal confirmed
        console.log(`🎰 [NairaSpinWheel] Withdrawal of ₦${d.amount} confirmed to ${d.bank_name} — Ref: ${ref}`);
        // Store in memory for status checks
        nswWithdrawals[ref] = {
          status      : 'SUCCESSFUL',
          amount      : d.amount,
          bank        : d.bank_name,
          account     : d.account_number,
          completed_at: nowISO(),
        };
      }

    } else if (d.status === 'FAILED') {
      console.log(`❌ [${appName}] Transfer FAILED Ref: ${ref} — ${d.complete_message || 'Unknown reason'}`);

      if (isIncomePM) {
        // Auto-refund IncomePM wallet
        for (const inv of Object.values(investors)) {
          const tx = inv.transactions.find(t => t.id === ref);
          if (tx && tx.type === 'withdraw' && tx.status === 'processing') {
            inv.wallet         += tx.amount;
            inv.totalWithdrawn -= tx.amount;
            tx.status           = 'failed';
            console.log(`💰 [IncomePM] Refunded ₦${tx.amount} to investor ${inv.userId}`);
          }
        }
      }

      if (isNairaSpinWheel) {
        console.log(`🎰 [NairaSpinWheel] Withdrawal FAILED — Ref: ${ref}. Player should be refunded.`);
        nswWithdrawals[ref] = { status: 'FAILED', completed_at: nowISO() };
      }
    }
  }

  // ── PAYMENT / DEPOSIT EVENTS ──────────────────────────────────
  if (type === 'charge.completed' && d.status === 'successful') {
    console.log(`💳 [${appName}] Payment received: ₦${d.amount} ${d.currency} — Ref: ${ref}`);

    if (isIncomePM) {
      // Find pending investor deposit and auto-activate
      console.log(`💰 [IncomePM] Deposit of ₦${d.amount} confirmed — Ref: ${ref}`);
    }
    if (isNairaSpinWheel) {
      console.log(`🎰 [NairaSpinWheel] Deposit of ₦${d.amount} confirmed — Ref: ${ref}`);
    }
  }

  res.status(200).json({ status: 'received', app: appName, ref });
});

// 404 — show all available routes
app.use((req, res) => {
  res.status(404).json({
    success  : false,
    message  : `Route "${req.method} ${req.path}" not found.`,
    hint     : 'Visit GET / for the full API directory.',
    available_routes: [
      'GET  /',
      'GET  /ip',
      'GET  /health',
      'GET  /banks',
      'POST /invest/confirm',
      'POST /invest/activate-manual',
      'GET  /earnings/:user_id',
      'POST /verify-account',
      'POST /withdraw',
      'POST /withdraw/status',
      'GET  /transactions/:user_id',
      'POST /webhook',
    ],
  });
});
// Error handler
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ success: false, message: err.message });
});

// ─── EARNINGS CRON — credit ₦200 every 60s for all active investors ─────────
setInterval(() => {
  const active = Object.values(investors).filter(i => i.active);
  if (active.length === 0) return;
  for (const inv of active) {
    inv.wallet      += EARN_RATE;
    inv.totalEarned += EARN_RATE;
    inv.minutesActive++;
    inv.transactions.push({
      id       : generateRef('MIN'),
      type     : 'earn',
      amount   : EARN_RATE,
      direction: 'credit',
      desc     : `Minute #${inv.minutesActive} earnings`,
      status   : 'success',
      ts       : nowISO(),
    });
  }
  if (active.length > 0) {
    console.log(`⏱️  Credited ₦${EARN_RATE} to ${active.length} investor(s) — ${new Date().toLocaleTimeString()}`);
  }
}, 60000);

// ─── START ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n💰 IncomePM Server running on port ${PORT}`);
  console.log(`🔑 Secret key    : ${FLW_SECRET_KEY ? '✅ ' + FLW_SECRET_KEY.slice(0,12) + '...' : '❌ MISSING'}`);
  console.log(`🔓 Public key    : ${FLW_PUBLIC_KEY ? '✅ ' + FLW_PUBLIC_KEY.slice(0,12) + '...' : '❌ MISSING'}`);
  console.log(`🪝 Webhook hash  : ${FLW_WEBHOOK_HASH ? '✅ ' + FLW_WEBHOOK_HASH : '❌ MISSING'}`);
  console.log(`📈 Earn rate     : ₦${EARN_RATE}/minute`);
  console.log(`💼 Min invest    : ₦${MIN_INVEST.toLocaleString()}`);
  console.log(`💼 Max invest    : ₦${MAX_INVEST.toLocaleString()}`);
  console.log(`📤 Min withdraw  : ₦${MIN_WITHDRAW}`);
  console.log(`📡 Webhook URL   : ${process.env.WEBHOOK_URL || 'Not set (optional)'}\n`);
});

module.exports = app;
