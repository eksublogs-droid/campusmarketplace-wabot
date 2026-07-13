const supabase = require('./supabaseClient');

// Tracks bot status in memory (fast, always accurate while the process is
// running) and mirrors it into Supabase so the dashboard can show
// "last known state" even right after a redeploy, before boot() finishes.
let state = {
  status: 'connecting', // 'connecting' | 'open'
  updatedAt: new Date().toISOString()
};

async function setStatus(status) {
  state = { status, updatedAt: new Date().toISOString() };
  try {
    await supabase.from('bot_kv').upsert({ key: 'bot_status', value: state });
  } catch (err) {
    // Non-fatal: in-memory state above already updated; Supabase mirror can lag.
  }
}

async function getStatus() {
  return state;
}

module.exports = { setStatus, getStatus };
