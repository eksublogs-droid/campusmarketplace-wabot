// In-memory session store for multi-step flows (per WhatsApp JID).
// Fine for a single-instance Railway deploy; if you ever scale to multiple
// instances, move this to Mongo/Redis too.
const sessions = {};

function getSession(jid) {
  return sessions[jid] || null;
}

function setSession(jid, step) {
  if (!sessions[jid]) {
    sessions[jid] = { step, data: {} };
  } else {
    sessions[jid].step = step;
  }
}

function updateSession(jid, data) {
  if (!sessions[jid]) sessions[jid] = { step: null, data: {} };
  sessions[jid].data = { ...sessions[jid].data, ...data };
}

function clearSession(jid) {
  delete sessions[jid];
}

module.exports = { getSession, setSession, updateSession, clearSession };
