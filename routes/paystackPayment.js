// EGF — Pro Plan Payment Verification (Paystack)
//
// Routes:
//   POST /api/register-payment-intent   { reference, amount, days }
//   POST /api/create-transfer-charge    { reference, amount, email }  <-- NEW
//   POST /api/verify-payment            { reference }
//   POST /api/paystack-relay
//
// create-transfer-charge calls Paystack's Charge API directly from the
// server (fast, stable connection) instead of letting the Paystack Inline
// popup fetch the transfer account over the user's (often slow) phone
// connection. Same one-time, expiring "Pay with Transfer" account you
// already get from the popup — just fetched via a faster path.
//
// Requires PAYSTACK_SECRET_KEY in Railway's environment variables.
//
// Storage: Supabase table `pro_plan_payments` (unchanged, see original
// comment block below).
//
//   create table pro_plan_payments (
//     id bigint generated always as identity primary key,
//     reference text unique not null,
//     amount integer,
//     days integer,
//     status text default 'pending',      -- pending | verified | failed
//     verified_amount_kobo integer,
//     created_at timestamptz default now(),
//     verified_at timestamptz
//   );

const supabase = require('../utils/supabaseClient');
const crypto = require('crypto');

function registerPaystackPaymentRoutes(app) {
  app.post('/api/register-payment-intent', async (req, res) => {
    const { reference, amount, days } = req.body || {};
    if (!reference) return res.status(400).json({ error: 'Missing reference' });

    try {
      await supabase.from('pro_plan_payments').insert({
        reference,
        amount: amount ? parseInt(amount, 10) : null,
        days: days ? parseInt(days, 10) : null,
        status: 'pending'
      });
    } catch (err) {
      console.error('register-payment-intent (non-fatal) failed:', err.message);
    }

    res.json({ ok: true });
  });

  // -------------------------------------------------------------------
  // POST /api/create-transfer-charge
  //
  // Server-to-server call to Paystack's Charge API asking for a "Pay with
  // Transfer" account directly — skips the Inline popup's own channel-
  // picker round trips (which run on the user's phone connection). Returns
  // the bank name / account number / expiry so the frontend can render its
  // own "Pay with Transfer" screen.
  // -------------------------------------------------------------------
  app.post('/api/create-transfer-charge', async (req, res) => {
    const { reference, amount, email } = req.body || {};
    if (!reference || !amount) {
      return res.status(400).json({ error: 'Missing reference or amount' });
    }

    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey) {
      console.error('create-transfer-charge: PAYSTACK_SECRET_KEY is not set in env');
      return res.status(500).json({ error: 'Payment not configured' });
    }

    try {
      // `amount` arrives here in kobo (frontend sends price * 100, same
      // unit Paystack expects). Store it in naira so this matches the
      // unit used by register-payment-intent — keeps the `amount` column
      // consistent no matter which payment path was used.
      await supabase.from('pro_plan_payments').insert({
        reference,
        amount: Math.round(parseInt(amount, 10) / 100),
        status: 'pending'
      });
    } catch (err) {
      console.error('create-transfer-charge: intent log (non-fatal) failed:', err.message);
    }

    try {
      const psRes = await fetch('https://api.paystack.co/charge', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: email || 'seller@campusmarketplace.ng',
          amount: Math.round(amount), // amount already expected in kobo from frontend
          reference,
          bank_transfer: {}
        })
      });
      const psData = await psRes.json();

      if (!psRes.ok || !psData.status) {
        console.error('create-transfer-charge: Paystack error:', psData.message);
        return res.status(502).json({ error: psData.message || 'Could not create transfer account' });
      }

      const details = psData.data && psData.data.bank_transfer;
      if (!details) {
        return res.status(502).json({ error: 'Paystack did not return transfer account details' });
      }

      return res.json({
        ok: true,
        bank_name: details.bank_name,
        account_number: details.account_number,
        account_expires_at: details.account_expires_at,
        reference
      });
    } catch (err) {
      console.error('create-transfer-charge: request error:', err.message);
      return res.status(502).json({ error: 'Could not reach Paystack' });
    }
  });

  app.post('/api/verify-payment', async (req, res) => {
    const { reference } = req.body || {};
    if (!reference) return res.status(400).json({ error: 'Missing reference' });

    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey) {
      console.error('verify-payment: PAYSTACK_SECRET_KEY is not set in env');
      return res.status(500).json({ verified: false, error: 'Payment verification not configured' });
    }

    try {
      const { data: existing } = await supabase
        .from('pro_plan_payments')
        .select('status, verified_amount_kobo')
        .eq('reference', reference)
        .maybeSingle();

      if (existing && existing.status === 'verified') {
        return res.json({ verified: true, amount: existing.verified_amount_kobo });
      }
    } catch (err) {
      console.error('verify-payment: pre-check lookup failed (continuing):', err.message);
    }

    try {
      const psRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secretKey}` }
      });
      const psData = await psRes.json();

      if (!psRes.ok || !psData.status) {
        return res.status(502).json({ verified: false, error: 'Paystack verify request failed' });
      }

      const txn = psData.data;
      const isSuccess = txn && txn.status === 'success';

      try {
        await supabase.from('pro_plan_payments').upsert({
          reference,
          status: isSuccess ? 'verified' : 'failed',
          verified_amount_kobo: txn ? txn.amount : null,
          verified_at: isSuccess ? new Date().toISOString() : null
        }, { onConflict: 'reference' });
      } catch (err) {
        console.error('verify-payment: saving result (non-fatal) failed:', err.message);
      }

      if (!isSuccess) {
        return res.json({ verified: false });
      }

      return res.json({ verified: true, amount: txn.amount });
    } catch (err) {
      console.error('verify-payment: Paystack request error:', err.message);
      return res.status(502).json({ verified: false, error: 'Could not reach Paystack' });
    }
  });

  app.post('/api/paystack-relay', async (req, res) => {
    const expectedSecret = process.env.EGF_RELAY_SECRET;
    const providedSecret = req.get('x-egf-relay-secret') || '';

    if (!expectedSecret) {
      console.error('paystack-relay: EGF_RELAY_SECRET is not set in env');
      return res.status(500).json({ ok: false, error: 'Relay not configured' });
    }

    const expectedBuf = Buffer.from(expectedSecret);
    const providedBuf = Buffer.from(providedSecret);
    const secretMatches = expectedBuf.length === providedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, providedBuf);

    if (!secretMatches) {
      return res.status(401).json({ ok: false, error: 'Invalid relay secret' });
    }

    const { reference, amount } = req.body || {};
    if (!reference) return res.status(400).json({ ok: false, error: 'Missing reference' });

    try {
      const { data: existing } = await supabase
        .from('pro_plan_payments')
        .select('status')
        .eq('reference', reference)
        .maybeSingle();

      if (existing && existing.status === 'verified') {
        return res.json({ ok: true, status: 'already verified' });
      }

      await supabase.from('pro_plan_payments').upsert({
        reference,
        status: 'verified',
        verified_amount_kobo: amount || null,
        verified_at: new Date().toISOString()
      }, { onConflict: 'reference' });

      return res.json({ ok: true, status: 'verified' });
    } catch (err) {
      console.error('paystack-relay: Supabase update failed:', err.message);
      return res.status(500).json({ ok: false, error: 'Storage error' });
    }
  });
}

module.exports = { registerPaystackPaymentRoutes };
