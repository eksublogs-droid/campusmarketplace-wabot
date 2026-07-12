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
//
// FIX: previously this tried WhatsApp's interactive "buttons" message first
// and only fell back to plain numbered text if sendMessage *threw*. In
// practice, on many devices WhatsApp doesn't throw at all — it silently
// accepts the message and just drops the footer and buttons on render,
// leaving the user with only the bare bodyText and no visible options or
// instructions. Since nothing errors, the fallback never triggered. Now we
// always send the numbered options directly inside the text body itself,
// so they're visible no matter what device/WhatsApp version renders it.
async function sendButtonMenu(sock, jid, bodyText, options, footerText) {
  const lines = [bodyText, ''];
  options.forEach((opt, i) => lines.push(`${i + 1}️⃣ ${opt.label}`));
  if (footerText) { lines.push(''); lines.push(footerText); }
  await sock.sendMessage(jid, { text: lines.join('\n') });
}

module.exports = { sendButtonMenu };
