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

// Builds an interactive `header` object from either a plain string (text
// header) or a { type: 'image'|'video'|'document', link } media header.
function buildHeader(header) {
  if (!header) return undefined;
  if (typeof header === 'string') return { type: 'text', text: header };
  return { type: header.type, [header.type]: header.id ? { id: header.id } : { link: header.link } };
}

// Converts our internal content shapes into a Cloud API message payload and
// sends it. Supports plain text/media (unchanged, original shapes) plus the
// official interactive types: buttons, list, cta_url, flow, and raw
// templates.
async function sendMessage(jid, content) {
  const to = toBarePhone(jid);
  if (!to) return null;

  let payload;
  if (content.text !== undefined) {
    payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: content.text, preview_url: false } };
  } else if (content.image) {
    // `id` (a WhatsApp-hosted media id) is preferred — no external fetch
    // for Meta to do, so nothing to fail silently in the background.
    // `link` still works as a fallback for callers that pass one (e.g. the
    // WordPress gallery preview flow uses plain URLs, not this function).
    payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: content.image.id
        ? { id: content.image.id, caption: content.caption || '' }
        : { link: content.image.url, caption: content.caption || '' }
    };
  } else if (content.video) {
    payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'video',
      video: content.video.id
        ? { id: content.video.id, caption: content.caption || '' }
        : { link: content.video.url, caption: content.caption || '' }
    };
  } else if (content.document) {
    payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: { link: content.document.url, caption: content.caption || '', filename: content.fileName || 'document.pdf' }
    };
  } else if (content.buttons) {
    // Reply-button interactive message. Max 3 buttons (WhatsApp limit) —
    // enforced by callers via utils/interactive.js.
    const b = content.buttons;
    payload = {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'button',
        ...(buildHeader(b.header) ? { header: buildHeader(b.header) } : {}),
        body: { text: b.body },
        ...(b.footer ? { footer: { text: b.footer } } : {}),
        action: { buttons: b.buttons.map(btn => ({ type: 'reply', reply: { id: btn.id, title: btn.title } })) }
      }
    };
  } else if (content.list) {
    // List-message interactive type. Max 10 rows total across sections —
    // enforced by callers via utils/interactive.js.
    const l = content.list;
    payload = {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'list',
        ...(buildHeader(l.header) ? { header: buildHeader(l.header) } : {}),
        body: { text: l.body },
        ...(l.footer ? { footer: { text: l.footer } } : {}),
        action: { button: l.buttonText || 'Choose', sections: l.sections }
      }
    };
  } else if (content.cta_url) {
    const c = content.cta_url;
    payload = {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'cta_url',
        ...(buildHeader(c.header) ? { header: buildHeader(c.header) } : {}),
        body: { text: c.body },
        ...(c.footer ? { footer: { text: c.footer } } : {}),
        action: { name: 'cta_url', parameters: { display_text: c.displayText, url: c.url } }
      }
    };
  } else if (content.flow) {
    // Opens a WhatsApp Flow. f.flowId must come from Meta's Flow Builder
    // (see flows/README.md) — there is no working fallback inside this
    // function; callers (utils/interactive.js#sendFlow) handle that by
    // checking flowId before calling sendMessage at all.
    //
    // `mode` matters: a Flow still in Draft state (not yet published in
    // WhatsApp Manager) is REJECTED by Meta with a "Integrity requirements
    // not met" error unless the request explicitly says mode: 'draft'.
    // See: https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/testingdebugging#send-draft-flow-to-your-device
    // Default here is 'published' (the normal case once the Flow is live);
    // pass f.mode: 'draft' from the caller while testing an unpublished Flow.
    const f = content.flow;
    payload = {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'flow',
        ...(buildHeader(f.header) ? { header: buildHeader(f.header) } : {}),
        body: { text: f.body },
        ...(f.footer ? { footer: { text: f.footer } } : {}),
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            mode: f.mode || 'published',
            flow_token: f.flowToken || `${to}_${Date.now()}`,
            flow_id: f.flowId,
            flow_cta: f.cta || 'Start',
            flow_action: 'navigate',
            ...(f.screen ? { flow_action_payload: { screen: f.screen, data: f.data || {} } } : {})
          }
        }
      }
    };
  } else if (content.template) {
    // Raw template send, for policy-required notifications (e.g. outside
    // the 24h customer service window). content.template must already be a
    // valid Graph API `template` object: { name, language: { code }, components }.
    payload = { messaging_product: 'whatsapp', to, type: 'template', template: content.template };
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
