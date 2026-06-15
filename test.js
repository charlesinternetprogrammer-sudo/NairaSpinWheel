/**
 * test.js — Quick API test script
 * Run: node test.js
 * Make sure the server is running first: npm start
 */

const BASE = process.env.TEST_URL || 'http://localhost:3000';

async function run() {
  console.log('🧪 Testing NairaSpinWheel Backend...\n');
  console.log(`📡 Server: ${BASE}\n`);

  // 1. Health check
  try {
    const res  = await fetch(`${BASE}/health`);
    const data = await res.json();
    console.log('✅ Health Check:', data.status, '| Ready:', data.ready);
    if (!data.ready) {
      console.log('⚠️  FLW_SECRET_KEY is not set. Withdrawal calls will fail.');
    }
  } catch (e) { console.log('❌ Health check failed:', e.message); return; }

  // 2. Banks list
  try {
    const res  = await fetch(`${BASE}/banks`);
    const data = await res.json();
    console.log(`✅ Banks endpoint: ${data.banks.length} banks returned`);
    console.log('   Sample:', data.banks.slice(0, 5).join(', '));
  } catch (e) { console.log('❌ Banks endpoint failed:', e.message); }

  // 3. Verify account (needs secret key set)
  try {
    const res  = await fetch(`${BASE}/verify-account`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ account_number: '2087106451', bank_name: 'United Bank For Africa' }),
    });
    const data = await res.json();
    if (data.success) {
      console.log(`✅ Account Verify: ${data.account_name} — ${data.account_number}`);
    } else {
      console.log('⚠️  Account Verify:', data.message, '(expected if secret key not set)');
    }
  } catch (e) { console.log('❌ Account verify failed:', e.message); }

  // 4. Withdrawal test (dry run — will fail without secret key but tests request format)
  try {
    const res  = await fetch(`${BASE}/withdraw`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        bank_name      : 'United Bank For Africa',
        account_number : '2087106451',
        account_name   : 'Dick Charles Benson',
        amount         : 500,
        phone          : '08012345678',
        narration      : 'Test withdrawal',
        source         : 'naira-spin-wheel',
      }),
    });
    const data = await res.json();
    if (data.success) {
      console.log(`✅ Withdrawal initiated! Ref: ${data.reference}`);
    } else {
      console.log('⚠️  Withdrawal:', data.message);
    }
  } catch (e) { console.log('❌ Withdrawal failed:', e.message); }

  console.log('\n🏁 Tests complete.');
}

run().catch(console.error);
