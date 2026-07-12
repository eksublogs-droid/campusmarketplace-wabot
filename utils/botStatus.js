const supabase = require('./supabaseClient');

// Tracks live connection state in memory (fast, always accurate while the
// process is running) and mirrors the essentials into Supabase so the
// dashboard can show "last known state" even right after a redeploy, before
// the socket reconnects.
let state = {
  status: 'connecting', // 'connecting' | 'open' | 'close'
  phone: null,
  updatedAt: new Date().toISOString()
};

async function setStatus(status, phone) {
  state = { status, phone: phone || state.phone, updatedAt: new Date().toISOString() };
  await supabase.from('auth_state').upsert({ key: 'bot_status', value: state }).catch(() => {});
}

async function getStatus() {
  return state;
}

async function loadPersistedStatus() {
  const { data } = await supabase.from('auth_state').select('value').eq('key', 'bot_status').maybeSingle();
  if (data && data.value) state = data.value;
  return state;
}

module.exports = { setStatus, getStatus, loadPersistedStatus };
