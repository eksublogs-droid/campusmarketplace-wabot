// Sends a WhatsApp "quick reply" interactive button message.
//
// ⚠️ Important caveat: WhatsApp has been inconsistent about rendering
// interactive buttons sent through unofficial libraries like Baileys —
// they show up fine on some app versions/devices and simply don't appear
// on others (WhatsApp can also silently change this at any time since it's
// not an officially supported feature outside the paid Business API).
//
// Because of that, every menu in this bot still accepts the OLD numbered
// text reply too ("1", "2", etc.) even when buttons are shown — so if a
// user's WhatsApp doesn't render the buttons, they can just type the number
// from the text version and everything still works.
//
// options: [{ id: 'buy', label: '🛍️ Buy Used Items' }, ...]
async function sendButtonMenu(sock, jid, bodyText, options, footerText) {
  try {
    await sock.sendMessage(jid, {
      text: bodyText,
      footer: footerText || '',
      buttons: options.map((opt, i) => ({
        buttonId: opt.id || String(i + 1),
        buttonText: { displayText: opt.label },
        type: 1
      })),
      headerType: 1
    });
  } catch (err) {
    console.error('Button send failed, falling back to text menu:', err.message);
    await sendTextFallback(sock, jid, bodyText, options, footerText);
  }
}

async function sendTextFallback(sock, jid, bodyText, options, footerText) {
  const lines = [bodyText, ''];
  options.forEach((opt, i) => lines.push(`${i + 1}️⃣ ${opt.label}`));
  if (footerText) { lines.push(''); lines.push(footerText); }
  await sock.sendMessage(jid, { text: lines.join('\n') });
}

module.exports = { sendButtonMenu };
