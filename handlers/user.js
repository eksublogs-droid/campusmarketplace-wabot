const userRepo = require('../repos/userRepo');
const productRepo = require('../repos/productRepo');
const { setSession, updateSession, getSession, clearSession } = require('../utils/session');
const { buildMenu } = require('../utils/menu');
const { sendButtonMenu } = require('../utils/buttons');
const { sendListMenu, sendButtons, sendCtaUrl } = require('../utils/interactive');
const { sendLikeHuman, pickVariant } = require('../utils/humanize');
const { resolveMediaUrl } = require('../utils/media');

const MAIN_OPTIONS = [
  { label: '💰 Buy Used Items', description: 'Browse affordable second-hand items from students near you' },
  { label: '💰 Sell Used Items', description: 'List an item you no longer need and reach buyers on campus' },
  { label: '📋 My Listings', description: 'View your posted items' },
  { label: '💎 Upgrade to Pro', description: 'Pin a listing to the top' },
  { label: '❓ Help', description: 'How to use this bot' }
];

// Only this number ever sees/can use the "Reset My Account" option —
// it's for the person testing the bot to replay the welcome/onboarding
// flow, not a feature for real users.
const TEST_RESET_PHONE = '2347043701799';
function isTestResetNumber(phone) {
  return (phone || '').replace(/\D/g, '') === TEST_RESET_PHONE;
}

// Several phrasings for the very first message a new contact gets — picked
// at random so it isn't a byte-identical template every time.
const WELCOME_VARIANTS = [
  '👋 Welcome to *EduGlobalForge*!\n\nTo get started, please send me your *name* and *Gmail address*.\n\nYou can write them together on one line, separated by a comma:\n📌 _John Doe, abcd1234@gmail.com_\n\nOr on two separate lines:\n📌 _John Doe_\n📌 _abcd1234@gmail.com_\n\nEither format works fine — just send whichever is easier for you.',
  '👋 Hey, thanks for reaching out — this is *EduGlobalForge*!\n\nPlease send your *name* and *Gmail address* so I can set up your account.\n\nOne line, comma-separated:\n📌 _John Doe, abcd1234@gmail.com_\n\nOr two lines:\n📌 _John Doe_\n📌 _abcd1234@gmail.com_\n\nAny of the two formats is fine.',
  '👋 Hi there! You\'ve reached *EduGlobalForge*.\n\nFirst, I\'ll need your *name* and *Gmail address*. You can send them either:\n\n1️⃣ On one line, separated by a comma:\n📌 _John Doe, abcd1234@gmail.com_\n\n2️⃣ Or on two lines:\n📌 _John Doe_\n📌 _abcd1234@gmail.com_\n\nWhichever is easier for you works.',
  '👋 Welcome aboard — *EduGlobalForge* here!\n\nMind sharing your *name* and *Gmail address*? You can send them together like this:\n📌 _John Doe, abcd1234@gmail.com_\n\nOr on separate lines:\n📌 _John Doe_\n📌 _abcd1234@gmail.com_'
];

// Generic fallback — used only when we truly have nothing to go on
// (empty message, or no name/email-like content at all).
const DETAILS_RETRY_TEXT =
  '❌ I couldn\'t read that. Please send your *name* and *Gmail address* in one of these formats:\n\n' +
  '📌 _John Doe, abcd1234@gmail.com_\n\n' +
  'or\n\n' +
  '📌 _John Doe_\n📌 _abcd1234@gmail.com_';

const FORMAT_HINT =
  '📌 _John Doe, abcd1234@gmail.com_\n\n' +
  'or\n\n' +
  '📌 _John Doe_\n📌 _abcd1234@gmail.com_';

function nameOnlyRetryText(name) {
  return `Hi *${name}*! I got your name, but I still need your *Gmail address* too.\n\n` +
    `Please resend both together in one of these formats:\n\n${FORMAT_HINT}`;
}

function emailOnlyRetryText() {
  return `📧 Got your email — but I still need your *name* too.\n\n` +
    `Please resend both together in one of these formats:\n\n${FORMAT_HINT}`;
}

function wrongFormatRetryText(nameGuess) {
  const greeting = nameGuess ? `Almost there, *${nameGuess}*!` : 'Almost there!';
  return `${greeting} You used the wrong format.\n\n` +
    `Please separate your *name* and *Gmail address* with a comma, or put them on two lines:\n\n${FORMAT_HINT}`;
}

// Pulls a usable email token out of raw free text, even if the rest of
// the message is messy (wrong separator, extra words, etc).
function extractEmailToken(raw) {
  const m = raw.match(/[^\s,]+@[^\s,]+/);
  return m ? m[0] : null;
}

// Strips leftover punctuation/whitespace from a name guess after the
// email token (and any comma) has been removed from the raw input.
function cleanupNameGuess(str) {
  return str.replace(/\n/g, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ')
    .trim().replace(/^[\s,.\-]+|[\s,.\-]+$/g, '').trim();
}

// When the strict parser fails, figure out *why* so we can give a
// specific retry message instead of a generic one.
// Returns { type: 'empty' | 'name_only' | 'email_only' | 'wrong_format', nameGuess }
function classifyFailedInput(raw) {
  if (!raw) return { type: 'empty', nameGuess: null };

  const emailToken = extractEmailToken(raw);
  if (!emailToken) {
    // No "@" at all — whatever they sent is presumably just a name.
    const nameGuess = cleanupNameGuess(raw);
    return nameGuess ? { type: 'name_only', nameGuess } : { type: 'empty', nameGuess: null };
  }

  const remainder = cleanupNameGuess(raw.split(emailToken).join(''));
  if (!remainder) return { type: 'email_only', nameGuess: null };

  // There's both an email-like token and leftover text — they likely
  // included both name and email but with the wrong separator/format.
  return { type: 'wrong_format', nameGuess: remainder };
}

// Shown when the user taps Edit — a plain re-ask, not an error, since
// nothing actually went wrong the first time.
const EDIT_PROMPT_TEXT =
  '✏️ No problem — please resend your *name* and *Gmail address* in one of these formats:\n\n' +
  '📌 _John Doe, abcd1234@gmail.com_\n\n' +
  'or\n\n' +
  '📌 _John Doe_\n📌 _abcd1234@gmail.com_';

async function askName(sock, jid) {
  setSession(jid, 'awaiting_details');
  await sendLikeHuman(sock, jid, pickVariant(WELCOME_VARIANTS));
}

// Accepts "Name, email" on one line, or "Name" / "email" on two lines.
// Nothing else — no other separator is treated as valid.
// Returns { name, email } or null if the shape can't be parsed.
function parseNameAndEmail(text) {
  const raw = (text || '').trim();
  if (!raw) return null;

  if (raw.includes(',')) {
    const idx = raw.indexOf(',');
    const name = raw.slice(0, idx).trim();
    const email = raw.slice(idx + 1).trim();
    if (name && email) return { name, email };
    return null;
  }

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    // Whichever line contains "@" is the email; the other is the name —
    // covers both "name then email" and "email then name" ordering.
    const emailLine = lines.find(l => l.includes('@'));
    const nameLine = lines.find(l => l !== emailLine);
    if (emailLine && nameLine) return { name: nameLine, email: emailLine };
  }
  return null;
}

async function handleDetailsInput(sock, jid, text, user) {
  const parsed = parseNameAndEmail(text);
  const emailValid = parsed && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.email);

  if (!parsed || !emailValid) {
    const raw = (text || '').trim();
    const { type, nameGuess } = classifyFailedInput(raw);

    if (type === 'name_only') {
      return sock.sendMessage(jid, { text: nameOnlyRetryText(nameGuess) });
    }
    if (type === 'email_only') {
      return sock.sendMessage(jid, { text: emailOnlyRetryText() });
    }
    if (type === 'wrong_format') {
      return sock.sendMessage(jid, { text: wrongFormatRetryText(nameGuess) });
    }
    return sock.sendMessage(jid, { text: DETAILS_RETRY_TEXT });
  }

  updateSession(jid, { pendingName: parsed.name, pendingEmail: parsed.email });
  setSession(jid, 'confirming_details');

  await sendButtons(
    sock, jid,
    `Please confirm your details:\n\n👤 *Name:* ${parsed.name}\n📧 *Email:* ${parsed.email}`,
    [
      { id: 'confirm_details', title: '✅ Confirm' },
      { id: 'edit_details', title: '✏️ Edit' }
    ]
  );
}

async function handleConfirmDetails(sock, jid, text, user) {
  const session = getSession(jid);
  const choice = (text || '').trim().toLowerCase();

  if (choice === 'edit_details') {
    setSession(jid, 'awaiting_details');
    return sock.sendMessage(jid, { text: EDIT_PROMPT_TEXT });
  }

  if (choice === 'confirm_details') {
    const { pendingName, pendingEmail } = (session && session.data) || {};
    if (!pendingName || !pendingEmail) {
      setSession(jid, 'awaiting_details');
      return sock.sendMessage(jid, { text: EDIT_PROMPT_TEXT });
    }
    const updated = await userRepo.updateUser(user.id, {
      name: pendingName, email: pendingEmail, email_submitted: true
    });
    clearSession(jid);
    await sock.sendMessage(jid, { text: `✅ Details saved! Welcome aboard, *${pendingName}*.` });
    await showMainMenu(sock, jid, updated);
    return updated;
  }

  return sendButtons(
    sock, jid,
    '❌ Please tap *Confirm* or *Edit* below.',
    [
      { id: 'confirm_details', title: '✅ Confirm' },
      { id: 'edit_details', title: '✏️ Edit' }
    ]
  );
}

async function showMainMenu(sock, jid, user) {
  clearSession(jid);
  setSession(jid, 'main_menu');
  const options = MAIN_OPTIONS.map((opt, i) => ({ id: String(i + 1), label: opt.label, description: opt.description }));
  if (isTestResetNumber(user.phone)) {
    options.push({
      id: 'reset_test_user',
      label: '🔄 Reset Account (test)',
      description: 'Wipe your name/email so onboarding shows again'
    });
  }
  await sendButtonMenu(
    sock, jid,
    `Hi *${user.name}*! What would you like to do?`,
    options,
    'You can also just type the number (1-5).'
  );
}

async function handleResetTestUser(sock, jid, user) {
  if (!isTestResetNumber(user.phone)) return showMainMenu(sock, jid, user); // safety net, button is hidden for everyone else anyway
  await userRepo.updateUser(user.id, { name: '', email: '', email_submitted: false });
  clearSession(jid);
  await sock.sendMessage(jid, { text: '🔄 Account reset. Here\'s the welcome flow again 👇' });
  await askName(sock, jid);
}

async function handleMainMenuChoice(sock, jid, idx, user) {
  if (idx === 0) return startBuyFlow(sock, jid, user, 0);
  if (idx === 1) return require('./sell').startSellFlow(sock, jid, user);
  if (idx === 2) return showMyListings(sock, jid, user);
  if (idx === 3) return require('./upgrade').startUpgradeFlow(sock, jid, user);
  if (idx === 4) return showHelp(sock, jid);
}

const PAGE_SIZE = 5;

async function startBuyFlow(sock, jid, user, page = 0) {
  const products = await productRepo.getActiveProducts(page * PAGE_SIZE, PAGE_SIZE);

  if (products.length === 0 && page === 0) {
    setSession(jid, 'main_menu');
    return sock.sendMessage(jid, { text: '📭 No items available right now. Check back soon!' });
  }
  if (products.length === 0) {
    return sock.sendMessage(jid, { text: '📭 No more items. Reply *0* to go back to the first page.' });
  }

  updateSession(jid, { buyPage: page, buyProductIds: products.map(p => p.id) });
  setSession(jid, 'browsing');

  // List message: each item is a row (id = its position, matching the old
  // numbered-reply convention so handleBrowsingChoice needs no changes),
  // with price/location as the row description. Pagination controls live
  // in their own section so they're always visible without eating into the
  // 10-row item limit unnecessarily.
  const itemRows = products.map((p, i) => ({
    id: String(i + 1),
    title: `${p.is_premium ? '💎 ' : ''}${p.name}`,
    description: `₦${Number(p.selling_price).toLocaleString()} — ${p.city || p.state || 'N/A'}`
  }));

  const navRows = [{ id: '9', title: '➡️ Next page' }];
  if (page > 0) navRows.unshift({ id: '0', title: '⬅️ Previous page' });
  else navRows.push({ id: '0', title: '↩️ Back to menu' });
  navRows.push({ id: 'menu', title: '🏠 Menu' });

  const sections = [{ title: `Page ${page + 1}`, rows: itemRows }];
  if (itemRows.length + navRows.length <= 10) sections.push({ title: 'Navigate', rows: navRows });

  await sendListMenu(
    sock, jid,
    `🛍️ *Available Items* (page ${page + 1})`,
    sections,
    { buttonText: 'View items' }
  );
}

async function handleBrowsingChoice(sock, jid, text, user) {
  const session = getSession(jid);
  const ids = (session && session.data && session.data.buyProductIds) || [];
  const page = (session && session.data && session.data.buyPage) || 0;

  const trimmed = (text || '').trim();
  if (trimmed === '9') return startBuyFlow(sock, jid, user, page + 1);
  if (trimmed === '0' && page > 0) return startBuyFlow(sock, jid, user, page - 1);
  if (trimmed === '0' && page === 0) return showMainMenu(sock, jid, user);

  const n = parseInt(trimmed, 10);
  if (isNaN(n) || n < 1 || n > ids.length) {
    return sock.sendMessage(jid, { text: '❌ Invalid choice. Reply with a listed number, *9* for next, or *0* to go back.' });
  }

  const product = await productRepo.getProductById(ids[n - 1]);
  if (!product) return sock.sendMessage(jid, { text: '❌ That item is no longer available.' });
  await sendProductCard(sock, jid, product, user);
}

async function sendProductCard(sock, jid, product, user) {
  const galleryLink = `https://eduglobalforge.com/pastquestions/listing?id=${product.id}`;
  const caption =
    `${product.is_premium ? '💎 *PRO LISTING*\n' : ''}` +
    `📦 *${product.name}*\n` +
    `💰 ₦${Number(product.selling_price).toLocaleString()}${product.negotiable ? ' (negotiable)' : ''}\n` +
    `⚙️ Condition: ${product.condition || 'N/A'}\n` +
    `📝 ${product.description || 'No description'}\n` +
    `📍 ${product.city || ''}, ${product.state || ''}\n` +
    `🚚 Dropoff: ${product.door_dropoff ? 'Yes' : 'No'} | 🚶 Pickup: ${product.door_pickup ? 'Yes' : 'No'}\n` +
    `🔗 See all photos: ${galleryLink}`;

  const firstMedia = Array.isArray(product.media) && product.media[0];

  // firstMedia.file_id is a Telegram file identifier, not a URL — it has
  // to be resolved to a fresh download link (valid ~1hr) right here,
  // every time, rather than stored/reused from an earlier resolve.
  let imageLink;
  if (firstMedia && firstMedia.type === 'photo' && firstMedia.file_id) {
    try { imageLink = await resolveMediaUrl(firstMedia.file_id); } catch (_) { imageLink = undefined; }
  }

  const buttons = [
    { id: '1', title: '💬 Contact Seller' },
    { id: '0', title: '⬅️ Back' },
    { id: 'menu', title: '🏠 Menu' }
  ];

  // sendButtons handles its own fallback chain internally (interactive ->
  // image+text -> plain text), so a single call covers the whole card.
  await sendButtons(sock, jid, caption, buttons, {
    header: imageLink ? { type: 'image', link: imageLink } : undefined
  });

  setSession(jid, 'viewing_product');
  updateSession(jid, { viewingProductId: product.id });
}

async function handleViewingProductChoice(sock, jid, text, user) {
  const session = getSession(jid);
  const productId = session && session.data && session.data.viewingProductId;
  const trimmed = (text || '').trim();

  if (trimmed === '0') return startBuyFlow(sock, jid, user, (session.data.buyPage) || 0);
  if (trimmed === '1' && productId) {
    const product = await productRepo.getProductById(productId);
    if (!product) return sock.sendMessage(jid, { text: '❌ Item no longer available.' });

    const sellerJid = product.seller_whatsapp
      ? `${product.seller_whatsapp.replace(/\D/g, '')}@s.whatsapp.net`
      : `${process.env.ADMIN_WHATSAPP}@s.whatsapp.net`;

    const introMsg =
      `🛍️ *New Buyer Interest — EduGlobalForge*\n\n` +
      `📦 Item: ${product.name}\n` +
      `👤 Buyer: ${user.name} (${user.phone})\n` +
      `📧 Email: ${user.email}\n\n` +
      `They'd like to discuss this item with you. Reply to this chat or contact them directly.`;

    await sock.sendMessage(sellerJid, { text: introMsg }).catch(() => {});
    await sock.sendMessage(jid, {
      text: `✅ Done! I've notified the seller — they (or our admin) will reach out to you directly on WhatsApp shortly.\n\nReply *0* to keep browsing.`
    });
    return;
  }
  return sock.sendMessage(jid, { text: '❌ Invalid choice. Reply *1* to contact seller or *0* to go back.' });
}

async function showMyListings(sock, jid, user) {
  const products = await productRepo.getProductsBySellerPhone(user.phone);
  if (products.length === 0) {
    setSession(jid, 'main_menu');
    return sock.sendMessage(jid, { text: '📭 You have no listings yet. Reply *2* from the main menu to sell an item.' });
  }
  let msg = `📋 *Your Listings*\n\n`;
  products.forEach(p => {
    msg += `• ${p.name} — ₦${Number(p.selling_price).toLocaleString()} [${p.status.toUpperCase()}]\n🆔 ${p.id}\n\n`;
  });
  msg += `Reply *menu* to return, or *4* from the main menu to upgrade one of these to Pro.`;
  setSession(jid, 'main_menu');
  await sock.sendMessage(jid, { text: msg });
}

async function showHelp(sock, jid) {
  setSession(jid, 'main_menu');
  const body =
    `❓ *Help*\n\n` +
    `Type *menu* anytime to return to the main menu.\n` +
    `Type *cancel* anytime to cancel what you're doing.`;

  const adminPhone = (process.env.ADMIN_WHATSAPP || '').replace(/\D/g, '');
  if (adminPhone) {
    return sendCtaUrl(sock, jid, body, '💬 Chat with Us', `https://wa.me/${adminPhone}`);
  }
  await sock.sendMessage(jid, { text: `${body}\n\nFor direct support, message our team.` });
}

module.exports = {
  askName, handleDetailsInput, handleConfirmDetails,
  showMainMenu, handleMainMenuChoice, handleResetTestUser, startBuyFlow, handleBrowsingChoice,
  handleViewingProductChoice, showMyListings, showHelp, MAIN_OPTIONS
};
