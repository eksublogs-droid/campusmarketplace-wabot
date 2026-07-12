const { createClient } = require('@supabase/supabase-js');

// SERVICE ROLE key on purpose — this bot runs entirely server-side and needs
// to bypass Row Level Security to read/write on behalf of all users.
// Never expose this key in a frontend/mini-app; only use it here in the bot.
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Supabase keys are JWTs — the middle segment is a base64 JSON payload with
// a "role" claim. If SUPABASE_SERVICE_ROLE_KEY was ever pasted from the
// wrong field in the dashboard (e.g. the anon key instead of service_role),
// every table grant/RLS setup can be perfectly correct and you'll still get
// "permission denied" on every query, because Postgres is correctly seeing
// you as "anon", not "service_role". This check surfaces that immediately
// at boot instead of it looking like a database/grant problem.
function decodedRole(jwt) {
  try {
    const payload = jwt.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')).role || null;
  } catch (_) {
    return null;
  }
}

if (key) {
  const role = decodedRole(key);
  if (role && role !== 'service_role') {
    console.error(
      `❌ SUPABASE_SERVICE_ROLE_KEY is a "${role}" key, not "service_role". ` +
      `This alone causes "permission denied for table X" on every query, no ` +
      `matter what grants exist. Fix: Supabase Dashboard → Settings → API → ` +
      `copy the "service_role" secret → replace SUPABASE_SERVICE_ROLE_KEY in ` +
      `Railway with it.`
    );
  }
}

const supabase = createClient(process.env.SUPABASE_URL, key);

module.exports = supabase;
