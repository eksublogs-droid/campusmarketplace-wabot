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

  // -------------------------------------------------------------------
  // POST /api/paystack-relay
  //
  // Paystack itself only supports ONE webhook URL per account, and that
  // URL is already pointed at WordPress (for regular egf_order payments).
  // So this route is NOT called by Paystack directly — it's called by
  // WordPress's own webhook handler, right after WordPress verifies the
  // real Paystack signature, whenever the paid reference is a Pro Plan
  // one (starts with "SELLPRO-"). This gives Pro Plan payments the same
  // server-to-server safety net regular orders already have, without
  // needing a second Paystack webhook slot.
  //
  // Trust here is a shared secret (EGF_RELAY_SECRET), NOT a Paystack
  // signature — WordPress already did that verification. Set this same
  // value in Railway's environment variables and in the
  // EGF_RAILWAY_RELAY_SECRET constant in the WordPress webhook snippet.
  // -------------------------------------------------------------------
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
      // Idempotency — same reasoning as verify-payment: don't reprocess
      // if this reference is already marked verified.
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
