const userRepo = require('../repos/userRepo');
const productRepo = require('../repos/productRepo');
const { setSession, updateSession, getSession, clearSession } = require('../utils/session');
const { buildMenu } = require('../utils/menu');
const { sendButtonMenu } = require('../utils/buttons');

const MAIN_OPTIONS = [
  { label: '🛍️ Buy Used Items' },
  { label: '💰 Sell an Item' },
  { label: '📋 My Listings' },
  { label: '💎 Upgrade a Listing to Pro' },
  { label: '❓ Help' }
];

async function askName(sock, jid) {
  setSession(jid, 'awaiting_name');
  await sock.sendMessage(jid, { text: '👋 Welcome to *CampusMarketplace*!\n\nWhat should I call you? (your first name)' });
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
    MAIN_OPTIONS.map((opt, i) => ({ id: String(i + 1), label: opt.label })),
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

  let msg = `🛍️ *Available Items* (page ${page + 1})\n\n`;
  products.forEach((p, i) => {
    msg += `${i + 1}️⃣ ${p.is_premium ? '💎 ' : ''}${p.name} — ₦${Number(p.selling_price).toLocaleString()}\n`;
    msg += `   📍 ${p.city || p.state || 'N/A'}\n\n`;
  });
  msg += `Reply with a number to view details.\nReply *9* for next page${page > 0 ? ', *0* for previous page' : ''}.`;

  await sock.sendMessage(jid, { text: msg });
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
  let caption =
    `${product.is_premium ? '💎 *PRO LISTING*\n' : ''}` +
    `📦 *${product.name}*\n` +
    `💰 ₦${Number(product.selling_price).toLocaleString()}${product.negotiable ? ' (negotiable)' : ''}\n` +
    `⚙️ Condition: ${product.condition || 'N/A'}\n` +
    `📝 ${product.description || 'No description'}\n` +
    `📍 ${product.city || ''}, ${product.state || ''}\n` +
    `🚚 Dropoff: ${product.door_dropoff ? 'Yes' : 'No'} | 🚶 Pickup: ${product.door_pickup ? 'Yes' : 'No'}`;

  const firstMedia = Array.isArray(product.media) && product.media[0];
  const buttons = [
    { buttonId: '1', buttonText: { displayText: '💬 Contact Seller' }, type: 1 },
    { buttonId: '0', buttonText: { displayText: '⬅️ Back' }, type: 1 }
  ];

  try {
    if (firstMedia && firstMedia.type === 'photo') {
      await sock.sendMessage(jid, {
        image: { url: firstMedia.url }, caption,
        footer: 'You can also just type 1 or 0.', buttons, headerType: 4
      });
    } else {
      await sock.sendMessage(jid, {
        text: caption, footer: 'You can also just type 1 or 0.', buttons, headerType: 1
      });
    }
  } catch (err) {
    console.error('Button send failed, falling back to text:', err.message);
    const fallback = caption + '\n\nReply *1* to contact the seller now, or *0* to go back.';
    if (firstMedia && firstMedia.type === 'photo') {
      await sock.sendMessage(jid, { image: { url: firstMedia.url }, caption: fallback });
    } else {
      await sock.sendMessage(jid, { text: fallback });
    }
  }

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
  await sock.sendMessage(jid, {
    text:
      `❓ *Help*\n\n` +
      `Type *menu* anytime to return to the main menu.\n` +
      `Type *cancel* anytime to cancel what you're doing.\n\n` +
      `For direct support, message our team.`
  });
}

module.exports = {
  askName, handleNameInput, handleEmailInput,
  showMainMenu, handleMainMenuChoice, startBuyFlow, handleBrowsingChoice,
  handleViewingProductChoice, showMyListings, showHelp, MAIN_OPTIONS
};
