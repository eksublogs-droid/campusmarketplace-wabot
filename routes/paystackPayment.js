// EGF — Pro Plan Payment Verification (Paystack)
//
// Two routes, fully self-contained:
//   POST /api/register-payment-intent  { reference, amount, days }
//   POST /api/verify-payment           { reference }
//
// Uses Paystack's own verify-transaction endpoint as the single source of
// truth (never trusts the browser's popup callback alone). Requires
// PAYSTACK_SECRET_KEY in Railway's environment variables — same secret key
// value already saved in your WordPress EGF Settings page.
//
// Storage: Supabase table `pro_plan_payments`. Create it once with:
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
//
// If this table doesn't exist yet, register-payment-intent just logs a
// warning and continues (non-fatal — it's a best-effort intent log), and
// verify-payment still works correctly using Paystack directly as the
// source of truth either way.

const supabase = require('../utils/supabaseClient');

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

  app.post('/api/verify-payment', async (req, res) => {
    const { reference } = req.body || {};
    if (!reference) return res.status(400).json({ error: 'Missing reference' });

    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey) {
      console.error('verify-payment: PAYSTACK_SECRET_KEY is not set in env');
      return res.status(500).json({ verified: false, error: 'Payment verification not configured' });
    }

    // ---- Idempotency: if we already verified this reference before, don't
    // hit Paystack again — just confirm it's still marked verified. ----
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
      // Table may not exist yet — non-fatal, fall through to Paystack check.
      console.error('verify-payment: pre-check lookup failed (continuing):', err.message);
    }

    // ---- Ask Paystack directly — this is the actual source of truth ----
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
}

module.exports = { registerPaystackPaymentRoutes };
