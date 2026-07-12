const { createClient } = require('@supabase/supabase-js');

// SERVICE ROLE key on purpose — this bot runs entirely server-side and needs
// to bypass Row Level Security to read/write on behalf of all users.
// Never expose this key in a frontend/mini-app; only use it here in the bot.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = supabase;
