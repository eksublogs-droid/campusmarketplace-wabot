// Builds a numbered text menu since WhatsApp (via Baileys, reliably) has no
// equivalent to Telegram's inline keyboards. Users reply with a digit.
// options: [{ label: '🛍️ Buy Used Items' }, { label: '💰 Sell an Item' }, ...]
function buildMenu(title, options, footer) {
  const lines = [title, ''];
  options.forEach((opt, i) => lines.push(`${i + 1}️⃣ ${opt.label}`));
  if (footer) {
    lines.push('');
    lines.push(footer);
  }
  return lines.join('\n');
}

// Parses a user's reply against a list of options, returns the matched index (0-based) or -1
function parseMenuChoice(text, optionsCount) {
  const n = parseInt((text || '').trim(), 10);
  if (isNaN(n) || n < 1 || n > optionsCount) return -1;
  return n - 1;
}

module.exports = { buildMenu, parseMenuChoice };
