// Human-like send helper — used for the very first message a stranger gets.
// An instant, word-for-word-identical reply to every new contact is one of
// the clearest automated-bot signatures WhatsApp's abuse detection watches
// for. This adds a randomized "read + type" pause (with a visible typing
// indicator) and picks from a few different phrasings so two strangers
// don't see byte-identical text back to back.

const MIN_DELAY_MS = 2500;
const MAX_DELAY_MS = 6000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickVariant(variants) {
  return variants[randomBetween(0, variants.length - 1)];
}

// Shows "typing…" for a human-plausible stretch, then sends the message.
async function sendLikeHuman(sock, jid, text) {
  const thinkMs = randomBetween(MIN_DELAY_MS, MAX_DELAY_MS);
  try {
    await sock.sendPresenceUpdate('composing', jid);
  } catch (_) {
    // Non-fatal — presence updates can fail independently of the socket
    // being otherwise healthy; the message send below still matters more.
  }
  await wait(thinkMs);
  try {
    await sock.sendPresenceUpdate('paused', jid);
  } catch (_) {}
  await sock.sendMessage(jid, { text });
}

module.exports = { sendLikeHuman, pickVariant };
