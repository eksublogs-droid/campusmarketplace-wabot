// WhatsApp Cloud API adapter.
//
// Exposes the exact same shape the rest of the codebase (handlers, repos,
// humanize.js) already calls on the Baileys `sock` object, so nothing
// outside this file and index.js needs to change:
//   sock.sendMessage(jid, { text })
//   sock.sendMessage(jid, { image: { url }, caption })
//   sock.sendPresenceUpdate(...) // no-op shim, Cloud API has no equivalent
//   sock.sendMessageRaw(...)     // same as sendMessage here (no double-typing to dedupe)
//
// JID shimming: Baileys uses `2348012345678@s.whatsapp.net`. Cloud API's
// Graph endpoint just wants the bare phone number. We keep the
// `@s.whatsapp.net` suffix on every jid passed in (so existing
// `jid.endsWith(...)` / `jid.replace('@s.whatsapp.net', ...)` logic in
// handlers keeps working untouched) and strip it only right before the
// actual HTTP call to Graph API.

const GRAPH_VERSION = 'v20.0';
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}`;

function toBarePhone(jid) {
  return String(jid).replace('@s.whatsapp.net', '').replace('@g.us', '');
}

async function graphPost(path, body) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Graph API error (${res.status})`);
    err.graphError = data?.error;
    throw err;
  }
  return data;
}

async function graphGet(path) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Graph API error (${res.status})`);
    err.graphError = data?.error;
    throw err;
  }
  return data;
}

// Converts our internal { text } / { image: { url }, caption } shape into
// a Cloud API message payload and sends it.
async function sendMessage(jid, content) {
  const to = toBarePhone(jid);
  if (!to) return null;

  let payload;
  if (content.text !== undefined) {
    payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: content.text, preview_url: false } };
  } else if (content.image) {
    payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { link: content.image.url, caption: content.caption || '' }
    };
  } else if (content.video) {
    payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'video',
      video: { link: content.video.url, caption: content.caption || '' }
    };
  } else if (content.document) {
    payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: { link: content.document.url, caption: content.caption || '', filename: content.fileName || 'document.pdf' }
    };
  } else {
    throw new Error('waCloudApi.sendMessage: unsupported content shape');
  }

  try {
    return await graphPost(`${PHONE_NUMBER_ID}/messages`, payload);
  } catch (err) {
    console.error(`sendMessage to ${to} failed:`, err.message);
    throw err;
  }
}

// No composing/paused indicator exists on Cloud API the way Baileys has it
// (Cloud API only lets you mark a specific inbound message as "read", which
// optionally shows a brief typing indicator tied to that message — handled
// separately by markAsRead() below). This is kept as a safe no-op so
// humanize.js and index.js's delay-based pacing logic don't need to change.
async function sendPresenceUpdate() {
  return null;
}

// Marks an inbound message as read. Cloud API also supports rendering a
// short native "typing…" indicator alongside the read receipt when you
// pass `typing_indicator`, which is the closest equivalent to Baileys'
// composing presence.
async function markAsRead(messageId, showTyping = false) {
  try {
    const body = { messaging_product: 'whatsapp', status: 'read', message_id: messageId };
    if (showTyping) body.typing_indicator = { type: 'text' };
    await graphPost(`${PHONE_NUMBER_ID}/messages`, body);
  } catch (err) {
    console.error('markAsRead failed:', err.message);
  }
}

// Downloads inbound media: Cloud API webhook gives you a media_id, not a
// buffer directly. Two-step: GET /{media-id} for a short-lived URL, then
// download that URL (also needs the access token header).
async function downloadMedia(mediaId) {
  const meta = await graphGet(mediaId);
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (!res.ok) throw new Error(`Failed to download media (${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Sends a reaction emoji to a specific inbound message (Phase 3 uses this).
async function sendReaction(jid, messageId, emoji) {
  const to = toBarePhone(jid);
  try {
    await graphPost(`${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'reaction',
      reaction: { message_id: messageId, emoji }
    });
  } catch (err) {
    console.error('sendReaction failed:', err.message);
  }
}

module.exports = {
  sendMessage,
  sendMessageRaw: sendMessage,
  sendPresenceUpdate,
  markAsRead,
  downloadMedia,
  sendReaction,
  toBarePhone
};
