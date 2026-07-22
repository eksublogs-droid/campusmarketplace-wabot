// "Buy Securely" flow — triggered when a buyer taps Buy Securely on the
// Buy Items page. The page opens WhatsApp with a prefilled message like:
//   "I'm interested in Samsung A14 (Ref: EGF-4821). I'd love to buy it."
// This handler recognises that message by its "Ref: EGF-xxxx" tag,
// explains the escrow flow, and routes the buyer to Proceed or Make Offer
// — both of which end in a prefilled "Contact Admin" link so a human
// closes every deal, matching how sell/upgrade flows already work here.

const productRepo = require('../repos/productRepo');
const { setSession, getSession, clearSession } = require('../utils/session');
const { sendButtons, sendCtaUrl } = require('../utils/interactive');

const LISTING_BASE_URL = 'https://eduglobalforge.com/buy-items/';

const REF_PATTERN = /\bEGF-\d+\b/i;

// True only for a first, fresh inbound message that names a product —
// never for a plain "yes"/button reply, which is handled separately by
// session step below.
function extractRef(text) {
  const m = REF_PATTERN.exec(text || '');
  return m ? m[0].toUpperCase() : null;
}

function money(n) {
  return `₦${Number(n || 0).toLocaleString()}`;
}

function adminNumber() {
  return (process.env.ADMIN_WHATSAPP || '').replace(/\D/g, '');
}

// Builds a wa.me link to the admin with a prefilled message — same
// wa.me?text= pattern already used elsewhere in this codebase.
function adminLink(message) {
  const num = adminNumber();
  return `https://wa.me/${num}?text=${encodeURIComponent(message)}`;
}

// Entry point for any inbound free-text message that contains a
// "Ref: EGF-xxxx" tag. Returns true if it handled the message (caller
// should stop routing further), false if there was no ref to act on.
async function handleBuyerInterestMessage(sock, jid, text) {
  const ref = extractRef(text);
  if (!ref) return false;

  const product = await productRepo.getProductByRef(ref);
  if (!product || product.status !== 'active') {
    await sock.sendMessage(jid, {
      text: `Sorry, I couldn't find an active listing for *${ref}* — it may have already sold or been taken down. You can browse what's currently available here: ${LISTING_BASE_URL}`
    });
    return true;
  }

  setSession(jid, 'buyer_interest');
  // Session data is in-memory only (utils/session.js), fine for this
  // short-lived back-and-forth.
  const session = getSession(jid);
  session.data = { ref: product.ref_code, name: product.name, price: product.selling_price };

  await sendButtons(
    sock, jid,
    `Hi! Thanks for your interest in *${product.name}* — listed for sale at ${money(product.selling_price)}.\n\n` +
    `Here's how it works: you'll meet the seller in person, check the item properly, and only pay once you're happy with it. ` +
    `But you never pay the seller directly — you pay into our EduGlobalForge Marketplace escrow account right there at the meeting, ` +
    `and we release it to the seller once everything's confirmed good.\n\n` +
    `Are you okay to proceed at ${money(product.selling_price)}, or would you like to make an offer?`,
    [
      { id: `buy_proceed_${product.ref_code}`, title: '✅ Proceed' },
      { id: `buy_offer_${product.ref_code}`, title: '💬 Make Offer' }
    ]
  );
  return true;
}

// Entry point for button-reply ids: buy_proceed_<ref> / buy_offer_<ref>.
// Returns true if it handled the id, false otherwise.
async function handleBuyerInterestButton(sock, jid, buttonId) {
  const proceedMatch = /^buy_proceed_(EGF-\d+)$/i.exec(buttonId || '');
  const offerMatch = /^buy_offer_(EGF-\d+)$/i.exec(buttonId || '');
  const match = proceedMatch || offerMatch;
  if (!match) return false;

  const ref = match[1].toUpperCase();
  const product = await productRepo.getProductByRef(ref);
  if (!product || product.status !== 'active') {
    clearSession(jid);
    await sock.sendMessage(jid, { text: `Sorry, *${ref}* is no longer available.` });
    return true;
  }

  const listingLink = `${LISTING_BASE_URL}?product=${product.ref_code}`;
  clearSession(jid);

  if (proceedMatch) {
    const msg = `Hi, I've confirmed to buy ${product.name} at ${money(product.selling_price)}. Product ID: ${product.ref_code}. Listing: ${listingLink}`;
    await sock.sendMessage(jid, { text: `✅ *Confirmed* — you're set to buy at ${money(product.selling_price)}. Tap below to message our admin and get connected with the seller.` });
    await sendCtaUrl(sock, jid, 'Ready when you are:', 'Contact Admin', adminLink(msg));
  } else {
    const msg = `Hi, I'd like to negotiate the price on ${product.name}. Product ID: ${product.ref_code}. Listing: ${listingLink}`;
    await sock.sendMessage(jid, { text: `💬 Want a negotiable price? Tap below to send your offer to our admin.` });
    await sendCtaUrl(sock, jid, 'Ready when you are:', 'Contact Admin', adminLink(msg));
  }
  return true;
}

module.exports = { extractRef, handleBuyerInterestMessage, handleBuyerInterestButton };
