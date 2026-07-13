// Backward-compatible wrapper: every existing call site does
//   sendButtonMenu(sock, jid, bodyText, options, footerText)
// with options shaped [{ id, label }]. That keeps working unchanged — it's
// now powered by the smart interactive engine (auto reply-buttons/list,
// with numbered-text fallback) instead of always sending plain text.
const { sendSmartMenu } = require('./interactive');

async function sendButtonMenu(sock, jid, bodyText, options, footerText) {
  return sendSmartMenu(sock, jid, bodyText, options, { footer: footerText });
}

module.exports = { sendButtonMenu };
