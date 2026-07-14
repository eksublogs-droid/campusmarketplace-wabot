const userRepo = require('../repos/userRepo');
const productRepo = require('../repos/productRepo');
const { setSession, updateSession, getSession, clearSession } = require('../utils/session');
const { buildMenu } = require('../utils/menu');
const { sendButtonMenu } = require('../utils/buttons');
const { sendListMenu, sendButtons, sendCtaUrl } = require('../utils/interactive');
const { sendLikeHuman, pickVariant } = require('../utils/humanize');
const { resolveMediaUrl } = require('../utils/media');

const MAIN_OPTIONS = [
  { label: '🛍️ Buy Items', description: 'Browse listings for sale' },
  { label: '💰 Sell an Item', description: 'List something to sell' },
  { label: '📋 My Listings', description: 'View your posted items' },
  { label: '💎 Upgrade to Pro', description: 'Pin a listing to the top' },
  { label: '❓ Help', description: 'How to use this bot' }
];

// Several phrasings for the very first message a new contact gets — picked
// at random so it isn't a byte-identical template every time.
const WELCOME_VARIANTS = [
  '👋 Welcome to *CampusMarketplace*!\n\nWhat should I call you? (your first name)',
  '👋 Hey, thanks for reaching out — this is *CampusMarketplace*!\n\nWhat\'s your first name?',
  '👋 Hi there! You\'ve reached *CampusMarketplace*.\n\nWhat should I call you? (first name is fine)',
  '👋 Welcome aboard — *CampusMarketplace* here!\n\nMind sharing your first name?'
];

async function askName(sock, jid) {
  setSession(jid, 'awaiting_name');
  await sendLikeHuman(sock, jid, pickVariant(WELCOME_VARIANTS));
}

async function handleNameInput(sock, jid, text, user) {
  const name = (text || '').trim();
  if (!name) return sock.sendMessage(jid, { text: 'Please type your name.' });
  const updated = await userRepo.updateUser(user.id, { name });
  setSession(jid, 'awaiting_email');
  await sock.sendMessage(jid, { text: `Nice to meet you, ${name}! 📧 What's your email address? (used for order confirmations)` });
  return updated;
}

async function handleEmailInput(sock, jid, text, user) {
  const email = (text || '').trim();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!valid) return sock.sendMessage(jid, { text: '❌ That doesn\'t look like a valid email. Try again:' });
  const updated = await userRepo.updateUser(user.id, { email, email_submitted: true });
  clearSession(jid);
  await showMainMenu(sock, jid, updated);
}

async function showMainMenu(sock, jid, user) {
  clearSession(jid);
  setSession(jid, 'main_menu');
  await sendButtonMenu(
    sock, jid,
    `Hi *${user.name}*! What would you like to do?`,
    MAIN_OPTIONS.map((opt, i) => ({ id: String(i + 1), label: opt.label, description: opt.description })),
    'You can also just type the number (1-5).'
  );
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

  const buttons = [{ id: '1', title: '💬 Contact Seller' }, { id: '0', title: '⬅️ Back' }];

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
      `🛍️ *New Buyer Interest — CampusMarketplace*\n\n` +
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
  askName, handleNameInput, handleEmailInput,
  showMainMenu, handleMainMenuChoice, startBuyFlow, handleBrowsingChoice,
  handleViewingProductChoice, showMyListings, showHelp, MAIN_OPTIONS
};
