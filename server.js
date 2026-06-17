/**
 * NairaSpinWheel + IncomePM — Backend Transfer Server
 * Powered by Flutterwave Transfer API (NIBSS/NIP)
 * Deploy on Render · Railway · Heroku
 */

const express    = require('express');
const axios      = require('axios');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const morgan     = require('morgan');
const crypto     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── SECRET KEY (set as environment variable — NEVER hardcode) ──────────────
const FLW_SECRET_KEY    = process.env.FLW_SECRET_KEY    || 'FLWSECK-8f6689cbe7d5d9a329d6d0792eb0133e-19eabc';
const FLW_PUBLIC_KEY    = process.env.FLW_PUBLIC_KEY || 'FLWPUBK-ae05ff3a19727ac119a4e8ca64c248a2-X';
const FLW_WEBHOOK_HASH  = process.env.FLW_WEBHOOK_HASH;  // set in Flutterwave dashboard
const FLW_BASE_URL      = 'https://api.flutterwave.com/v3';

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — allow your frontend domains
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST'],
}));

// Rate limiting — prevent abuse
const withdrawLimiter = rateLimit({
  windowMs : 15 * 60 * 1000, // 15 minutes
  max      : 10,              // max 10 withdrawal requests per IP per 15 min
  message  : { success: false, message: 'Too many requests. Please wait 15 minutes.' },
});

// ─── SUPPORTED NIGERIAN BANKS (NIP bank codes) ──────────────────────────────
const BANK_CODES = {
  'Access Bank'              : '044',
  'GTBank'                   : '058',
  'First Bank of Nigeria'    : '011',
  'Zenith Bank'              : '057',
  'UBA'                      : '033',
  'United Bank For Africa'   : '033',
  'Fidelity Bank'            : '070',
  'Union Bank'               : '032',
  'Sterling Bank'            : '232',
  'Stanbic IBTC'             : '221',
  'FCMB'                     : '214',
  'Ecobank Nigeria'          : '050',
  'Keystone Bank'            : '082',
  'Polaris Bank'             : '076',
  'Wema Bank'                : '035',
  'Heritage Bank'            : '030',
  'Opay'                     : '100004',
  'Kuda Bank'                : '50211',
  'PalmPay'                  : '100033',
  'Moniepoint'               : '50515',
};

// ─── HELPERS ────────────────────────────────────────────────────────────────
function getBankCode(bankName) {
  if (!bankName) return null;
  // Try exact match first
  if (BANK_CODES[bankName]) return BANK_CODES[bankName];
  // Try case-insensitive partial match
  const lower = bankName.toLowerCase();
  for (const [name, code] of Object.entries(BANK_CODES)) {
    if (lower.includes(name.toLowerCase()) || name.toLowerCase().includes(lower)) {
      return code;
    }
  }
  return null;
}

function generateRef(prefix = 'NSW') {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function maskAccount(acct) {
  if (!acct) return '****';
  return '******' + String(acct).slice(-4);
}

function maskPhone(phone) {
  if (!phone) return '****';
  return String(phone).slice(0, 4) + '****' + String(phone).slice(-3);
}

function buildSmsText(firstName, amount, bank, maskedAcct, ref) {
  return (
    `Dear ${firstName}, ₦${Number(amount).toLocaleString('en-NG')} has been sent to ` +
    `your ${bank} account ${maskedAcct}. Ref: ${ref}. ` +
    `Transfer via NIBSS/NIP. Arrives within 5 mins. - NairaSpinWheel/IncomePM`
  );
}

// ─── GUARD — abort if secret key missing ────────────────────────────────────
app.use((req, res, next) => {
  if (['/health', '/banks'].includes(req.path)) return next();
  if (!FLW_SECRET_KEY) {
    return res.status(503).json({
      success: false,
      message: 'Server not configured: FLW_SECRET_KEY environment variable is missing.',
    });
  }
  next();
});

// ────────────────────────────────────────────────────────────────────────────
// ROUTES
// ────────────────────────────────────────────────────────────────────────────

// GET /health — uptime check
app.get('/health', (req, res) => {
  res.json({
    status   : 'ok',
    service  : 'NairaSpinWheel Transfer Server',
    version  : '1.0.0',
    timestamp: new Date().toISOString(),
    ready    : !!FLW_SECRET_KEY,
  });
});

// GET /banks — return supported banks list
app.get('/banks', (req, res) => {
  res.json({
    success: true,
    banks  : Object.keys(BANK_CODES),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /verify-account — verify a bank account before transfer
// Body: { account_number, bank_name }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/verify-account', async (req, res) => {
  const { account_number, bank_name } = req.body;

  if (!account_number || !bank_name) {
    return res.status(400).json({ success: false, message: 'account_number and bank_name are required.' });
  }

  const bankCode = getBankCode(bank_name);
  if (!bankCode) {
    return res.status(400).json({ success: false, message: `Bank "${bank_name}" not found or not supported.` });
  }

  try {
    const { data } = await axios.get(
      `${FLW_BASE_URL}/accounts/resolve`,
      {
        params : { account_number, account_bank: bankCode },
        headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` },
      }
    );

    if (data.status === 'success') {
      return res.json({
        success     : true,
        account_name: data.data.account_name,
        account_number: data.data.account_number,
        bank_code   : bankCode,
        bank_name,
      });
    }

    return res.status(422).json({ success: false, message: data.message || 'Could not verify account.' });

  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('[verify-account] Error:', msg);
    return res.status(500).json({ success: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /withdraw — initiate a real Flutterwave transfer (NIBSS/NIP)
// Body: {
//   bank_name, account_number, account_name,
//   amount, phone, narration?, source (naira-spin-wheel | income-pm)
// }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/withdraw', withdrawLimiter, async (req, res) => {
  const {
    bank_name,
    account_number,
    account_name,
    amount,
    phone,
    narration,
    source,
  } = req.body;

  // ── Validation ──────────────────────────────────────────────────────────
  if (!bank_name)      return res.status(400).json({ success: false, message: 'bank_name is required.' });
  if (!account_number) return res.status(400).json({ success: false, message: 'account_number is required.' });
  if (!account_name)   return res.status(400).json({ success: false, message: 'account_name is required.' });
  if (!amount)         return res.status(400).json({ success: false, message: 'amount is required.' });
  if (!phone)          return res.status(400).json({ success: false, message: 'phone is required.' });

  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount < 100) {
    return res.status(400).json({ success: false, message: 'Minimum withdrawal amount is ₦100.' });
  }
  if (numAmount > 5000000) {
    return res.status(400).json({ success: false, message: 'Maximum single withdrawal is ₦5,000,000.' });
  }

  const acctStr = String(account_number).trim();
  if (!/^\d{10}$/.test(acctStr) && !/^\d{6,12}$/.test(acctStr)) {
    return res.status(400).json({ success: false, message: 'Invalid account number format.' });
  }

  const bankCode = getBankCode(bank_name);
  if (!bankCode) {
    return res.status(400).json({ success: false, message: `Bank "${bank_name}" is not supported.` });
  }

  const txRef       = generateRef(source === 'income-pm' ? 'IPM' : 'NSW');
  const firstName   = String(account_name).split(' ')[0];
  const maskedAcct  = maskAccount(acctStr);
  const maskedPhone = maskPhone(String(phone));
  const smsText     = buildSmsText(firstName, numAmount, bank_name, maskedAcct, txRef);

  const payload = {
    account_bank   : bankCode,
    account_number : acctStr,
    amount         : numAmount,
    narration      : narration || `Payout from ${source === 'income-pm' ? 'IncomePM' : 'NairaSpinWheel'}`,
    currency       : 'NGN',
    reference      : txRef,
    callback_url   : process.env.WEBHOOK_URL || '',
    debit_currency : 'NGN',
    meta           : [{ AccountNumber: acctStr, RoutingNumber: bankCode, SwiftCode: '', BankName: bank_name, BeneficiaryName: account_name, Mobile: phone }],
  };

  try {
    const { data } = await axios.post(
      `${FLW_BASE_URL}/transfers`,
      payload,
      { headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, 'Content-Type': 'application/json' } }
    );

    if (data.status === 'success' || data.data?.status === 'NEW' || data.data?.status === 'PENDING') {
      const now      = new Date();
      const timeStr  = now.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const dateStr  = now.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' });

      return res.json({
        success      : true,
        message      : 'Transfer initiated successfully via NIBSS/NIP.',
        reference    : txRef,
        flw_ref      : data.data?.id || data.data?.reference || null,
        amount       : numAmount,
        bank         : bank_name,
        account      : maskedAcct,
        status       : data.data?.status || 'PENDING',
        time         : timeStr,
        date         : dateStr,
        phone_masked : maskedPhone,
        sms_alert    : smsText,
        eta          : 'Arrives within 1–10 minutes via NIBSS/NIP',
      });
    }

    return res.status(422).json({
      success: false,
      message: data.message || 'Transfer could not be initiated.',
      raw    : data,
    });

  } catch (err) {
    const errMsg = err.response?.data?.message || err.message || 'Unknown error';
    console.error('[withdraw] Flutterwave Error:', errMsg, err.response?.data);
    return res.status(500).json({
      success: false,
      message: 'Transfer failed: ' + errMsg,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /withdraw/status — check transfer status by reference
// Body: { reference }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/withdraw/status', async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ success: false, message: 'reference is required.' });

  try {
    const { data } = await axios.get(
      `${FLW_BASE_URL}/transfers`,
      {
        params : { reference },
        headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` },
      }
    );

    const transfer = data.data?.[0] || data.data;
    if (transfer) {
      return res.json({
        success  : true,
        reference: transfer.reference,
        status   : transfer.status,
        amount   : transfer.amount,
        bank     : transfer.bank_name || transfer.account_bank,
        account  : maskAccount(transfer.account_number),
        created  : transfer.created_at,
        complete : transfer.status === 'SUCCESSFUL',
      });
    }

    return res.status(404).json({ success: false, message: 'Transfer not found.' });

  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('[withdraw/status] Error:', msg);
    return res.status(500).json({ success: false, message: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook — Flutterwave transfer webhook (set URL in dashboard)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  // Verify webhook signature
  const signature = req.headers['verif-hash'];
  if (FLW_WEBHOOK_HASH && signature !== FLW_WEBHOOK_HASH) {
    console.warn('[webhook] Invalid signature received');
    return res.status(401).json({ message: 'Invalid signature' });
  }

  let event;
  try { event = JSON.parse(req.body); } catch (e) { event = req.body; }

  const eventType = event.event;
  const data      = event.data;

  console.log(`[webhook] Event: ${eventType}`, JSON.stringify(data, null, 2));

  if (eventType === 'transfer.completed') {
    if (data.status === 'SUCCESSFUL') {
      console.log(`✅ Transfer SUCCESSFUL: ₦${data.amount} → ${data.account_number} (${data.bank_name}) Ref: ${data.reference}`);
      // TODO: Update your database record to mark withdrawal as complete
    } else if (data.status === 'FAILED') {
      console.log(`❌ Transfer FAILED: Ref: ${data.reference}, Reason: ${data.complete_message}`);
      // TODO: Refund the user's wallet balance in your database
    }
  }

  res.status(200).json({ status: 'received' });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /verify-payment — verify a deposit transaction after Flutterwave redirect
// Body: { transaction_id }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/verify-payment', async (req, res) => {
  const { transaction_id } = req.body;
  if (!transaction_id) return res.status(400).json({ success: false, message: 'transaction_id is required.' });

  try {
    const { data } = await axios.get(
      `${FLW_BASE_URL}/transactions/${transaction_id}/verify`,
      { headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` } }
    );

    if (data.status === 'success' && data.data.status === 'successful') {
      return res.json({
        success   : true,
        amount    : data.data.amount,
        currency  : data.data.currency,
        reference : data.data.tx_ref,
        flw_ref   : data.data.flw_ref,
        customer  : data.data.customer,
        verified  : true,
      });
    }

    return res.status(422).json({
      success : false,
      message : 'Payment not verified.',
      status  : data.data?.status,
    });

  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('[verify-payment] Error:', msg);
    return res.status(500).json({ success: false, message: msg });
  }
});

// 404 handler
app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found.' }));

// Global error handler
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ success: false, message: err.message || 'Internal server error.' });
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 NairaSpinWheel Transfer Server running on port ${PORT}`);
  console.log(`🔑 Secret key: ${FLW_SECRET_KEY ? '✅ Loaded' : '❌ MISSING — set FLW_SECRET_KEY env var'}`);
  console.log(`📡 Webhook:    ${process.env.WEBHOOK_URL || 'Not set (optional)'}\n`);
});

module.exports = app;
