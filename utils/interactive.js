// Smart interactive-message helpers for the WhatsApp Cloud API.
//
// Every function here tries the requested official interactive type first
// (reply buttons / list / CTA URL / flow) and transparently falls back to a
// plain numbered text message if the interactive send fails for any reason
// (Graph API error, unsupported type on the recipient's client, malformed
// payload, etc.) — so the conversation never dead-ends.
//
// Handlers don't need to know or care which message type actually went out.
// They just call these helpers and keep routing replies through the normal
// session/menu pipeline, because a WhatsApp button/list reply's `id` is
// always the same value that would have been typed as a numbered text
// reply (see index.js `extractText`). That's what lets this whole upgrade
// slot in without changing any handler's *reply-parsing* logic.

const MAX_BUTTONS = 3;
const MAX_BUTTON_TITLE = 20;  // WhatsApp hard limit
const MAX_ROW_TITLE = 24;     // WhatsApp hard limit
const MAX_ROW_DESC = 72;      // WhatsApp hard limit
const MAX_LIST_ROWS = 10;     // WhatsApp hard limit (across all sections)

function truncate(str, max) {
  str = String(str == null ? '' : str);
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// Plain numbered-text fallback for any option list — same shape as the
// original utils/menu.js so a user whose client can't render the
// interactive UI can still just type a number and everything keeps working.
function textFallback(bodyText, options, footerText) {
  const lines = [bodyText, ''];
  options.forEach((opt, i) => lines.push(`${i + 1}️⃣ ${opt.title || opt.label}`));
  if (footerText) { lines.push(''); lines.push(footerText); }
  return lines.join('\n');
}

// options: [{ id, title|label, description? }]
// Picks reply buttons (<=3 options) or a list message (4-10 options).
// >10 options has no clean official interactive fit, so it stays text.
async function sendSmartMenu(sock, jid, bodyText, options, opts = {}) {
  const { footer, header, buttonText = 'Choose', listTitle = 'Options' } = opts;

  if (options.length > MAX_LIST_ROWS) {
    return sock.sendMessage(jid, { text: textFallback(bodyText, options, footer) });
  }

  try {
    if (options.length <= MAX_BUTTONS) {
      return await sock.sendMessage(jid, {
        buttons: {
          body: bodyText,
          footer,
          header,
          buttons: options.map(o => ({ id: String(o.id), title: truncate(o.title || o.label, MAX_BUTTON_TITLE) }))
        }
      });
    }

    return await sock.sendMessage(jid, {
      list: {
        body: bodyText,
        footer,
        header,
        buttonText,
        sections: [{
          title: truncate(listTitle, MAX_ROW_TITLE),
          rows: options.map(o => ({
            id: String(o.id),
            title: truncate(o.title || o.label, MAX_ROW_TITLE),
            description: o.description ? truncate(o.description, MAX_ROW_DESC) : undefined
          }))
        }]
      }
    });
  } catch (err) {
    console.error('sendSmartMenu interactive send failed, falling back to text:', err.message);
    return sock.sendMessage(jid, { text: textFallback(bodyText, options, footer) });
  }
}

// Multi-section list (e.g. grouping products, or mixing items with
// pagination controls in their own section).
// sections: [{ title, rows: [{ id, title|label, description? }] }]
async function sendListMenu(sock, jid, bodyText, sections, opts = {}) {
  const { footer, header, buttonText = 'Choose' } = opts;
  const flatOptions = sections.flatMap(s => s.rows);

  if (flatOptions.length > MAX_LIST_ROWS) {
    return sock.sendMessage(jid, { text: textFallback(bodyText, flatOptions, footer) });
  }

  try {
    return await sock.sendMessage(jid, {
      list: {
        body: bodyText, footer, header, buttonText,
        sections: sections.map(s => ({
          title: truncate(s.title, MAX_ROW_TITLE),
          rows: s.rows.map(o => ({
            id: String(o.id),
            title: truncate(o.title || o.label, MAX_ROW_TITLE),
            description: o.description ? truncate(o.description, MAX_ROW_DESC) : undefined
          }))
        }))
      }
    });
  } catch (err) {
    console.error('sendListMenu failed, falling back to text:', err.message);
    return sock.sendMessage(jid, { text: textFallback(bodyText, flatOptions, footer) });
  }
}

// Reply buttons with an optional media header (e.g. a product photo) —
// falls back to a plain image+caption or plain text if the interactive
// send fails.
// header: string (text) | { type: 'image'|'video'|'document', link }
async function sendButtons(sock, jid, bodyText, buttons, opts = {}) {
  const { footer, header } = opts;
  try {
    return await sock.sendMessage(jid, {
      buttons: {
        body: bodyText,
        footer,
        header,
        buttons: buttons.map(b => ({ id: String(b.id), title: truncate(b.title || b.label, MAX_BUTTON_TITLE) }))
      }
    });
  } catch (err) {
    console.error('sendButtons failed, falling back:', err.message);
    if (header && typeof header === 'object' && header.link) {
      try {
        await sock.sendMessage(jid, { image: { url: header.link }, caption: textFallback(bodyText, buttons, footer) });
        return;
      } catch (_) { /* fall through to plain text */ }
    }
    return sock.sendMessage(jid, { text: textFallback(bodyText, buttons, footer) });
  }
}

// A CTA URL button (e.g. "Chat with Support", "View on Website"). Falls
// back to a plain text message containing the raw link.
async function sendCtaUrl(sock, jid, bodyText, displayText, url, opts = {}) {
  const { footer, header } = opts;
  try {
    return await sock.sendMessage(jid, {
      cta_url: { body: bodyText, footer, header, displayText: truncate(displayText, MAX_BUTTON_TITLE), url }
    });
  } catch (err) {
    console.error('sendCtaUrl failed, falling back to text:', err.message);
    return sock.sendMessage(jid, { text: `${bodyText}\n\n🔗 ${displayText}: ${url}` });
  }
}

// Launches a WhatsApp Flow (multi-step structured form). Requires a Flow
// already published in Meta's Flow Builder, with its ID passed as flowId.
// If flowId isn't configured, or the send fails, returns false so the
// caller can transparently fall back to a normal chat conversation — Flows
// are additive here, never a hard requirement.
async function sendFlow(sock, jid, { flowId, flowToken, bodyText, cta, screen, data, footer, header }) {
  if (!flowId) return false;
  try {
    await sock.sendMessage(jid, {
      flow: { body: bodyText, footer, header, flowId, flowToken, cta, screen, data }
    });
    return true;
  } catch (err) {
    console.error('sendFlow failed, caller should fall back to chat steps:', err.message);
    return false;
  }
}

module.exports = { sendSmartMenu, sendListMenu, sendButtons, sendCtaUrl, sendFlow, textFallback };
