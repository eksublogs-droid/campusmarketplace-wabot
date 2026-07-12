// Human-like send helper — used for the very first message a stranger gets.
// An instant, word-for-word-identical reply to every new contact is one of
// the clearest automated-bot signatures WhatsApp's abuse detection watches
// for. This adds a randomized "read + type" pause (with a visible typing
// indicator) and picks from a few different phrasings so two strangers
// don't see byte-identical text back to back.
//
// FIX: added a minimum gap between successive welcome sends. If several
// new contacts message the bot within the same few seconds, they'd
// previously all get their "typing" pause + reply on independent,
// overlapping timers — several automated sends firing in the same instant
// is itself a burst pattern WhatsApp's automation detection can key off
// (see WhiskeySockets/Baileys#1850: high-velocity automated conversations
// triggering restriction). This staggers them by a small fixed minimum,
// invisible to any individual user, without meaningfully delaying anyone.

const MIN_DELAY_MS = 2500;
const MAX_DELAY_MS = 6000;
const MIN_GAP_BETWEEN_SENDS_MS = 1500;

let lastSendAt = 0;

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

  // Reserve a send slot at least MIN_GAP_BETWEEN_SENDS_MS after the last
  // one, so a burst of new contacts doesn't produce several automated
  // sends in the same moment.
  const now = Date.now();
  const earliestSlot = Math.max(now, lastSendAt + MIN_GAP_BETWEEN_SENDS_MS);
  lastSendAt = earliestSlot;
  const extraGapMs = earliestSlot - now;

  try {
    await sock.sendPresenceUpdate('composing', jid);
  } catch (_) {
    // Non-fatal — presence updates can fail independently of the socket
    // being otherwise healthy; the message send below still matters more.
  }
  await wait(thinkMs + extraGapMs);
  try {
    await sock.sendPresenceUpdate('paused', jid);
  } catch (_) {}
  await sock.sendMessage(jid, { text });
}

module.exports = { sendLikeHuman, pickVariant };
