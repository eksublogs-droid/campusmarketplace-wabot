const productRepo = require('../repos/productRepo');
const settingsRepo = require('../repos/settingsRepo');
const paymentRepo = require('../repos/paymentRepo');
const userRepo = require('../repos/userRepo');
const { deleteFiles } = require('../utils/media');
const { getSession, setSession, clearSession } = require('../utils/session');
const { sendButtons } = require('../utils/interactive');

const LISTING_BASE_URL = 'https://eduglobalforge.com/buy-items/';

function isAdmin(phoneOrJid) {
  const digits = (phoneOrJid || '').replace(/\D/g, '');
  return digits === (process.env.ADMIN_WHATSAPP || '').replace(/\D/g, '');
}

// Admin uses plain-text commands (low-frequency actions, no menu needed):
//   pending                          -> list listings awaiting review
//   approve <id>                     -> approve a listing
//   reject <id> [reason]             -> reject a listing
//   listings                         -> show active listings
//   sold <id>                        -> mark a listing sold
//   receipts                         -> list pending payment receipts
//   approve receipt <id>             -> approve a receipt -> pins listing
//   reject receipt <id> [reason]     -> reject a receipt
//   settings                         -> view bank/pricing settings
async function handleAdminCommand(sock, jid, text) {
  const trimmed = (text || '').trim();
  const lower = trimmed.toLowerCase();

  // ===== Search Product (two-step: menu button / "find" then a ref code) =====
  // Checked before anything else so a bare ref code like "EGF-4821" sent in
  // reply to the prompt below is read as that ref, not as an unknown command.
  const adminSession = getSession(jid);
  if (adminSession && adminSession.step === 'admin_awaiting_ref') {
    clearSession(jid);
    await searchProductByRef(sock, jid, trimmed);
    return true;
  }
  if (lower === 'admin_search_product' || lower === 'find' || lower === 'search product') {
    setSession(jid, 'admin_awaiting_ref');
    await sock.sendMessage(jid, { text: 'Please send the Product ID (e.g. EGF-4821)' });
    return true;
  }
  if (lower.startsWith('find ')) {
    return searchProductByRef(sock, jid, trimmed.slice(5).trim());
  }

  if (lower === 'pending') return showPending(sock, jid);
  if (lower === 'listings') return showActiveListings(sock, jid);
  if (lower === 'settings') return showSettings(sock, jid);
  if (lower === 'receipts') return showPendingReceipts(sock, jid);
  if (lower === 'help' || lower === 'admin') return showAdminHelp(sock, jid);

  // setbank Bank Name | 0123456789 | Account Name
  if (lower.startsWith('setbank ')) {
    const raw = trimmed.slice(8);
    const parts = raw.split('|').map(s => s.trim());
    if (parts.length !== 3) {
      return sock.sendMessage(jid, { text: '❌ Format: *setbank Bank Name | Account Number | Account Name*' });
    }
    const [bankName, accountNumber, accountName] = parts;
    await settingsRepo.addBankAccount(bankName, accountNumber, accountName);
    return sock.sendMessage(jid, { text: `✅ Bank account added:\n🏦 ${bankName}\n🔢 ${accountNumber}\n👤 ${accountName}` });
  }

  if (lower.startsWith('removebank ')) {
    const idx = parseInt(trimmed.split(' ')[1], 10) - 1; // 1-based for the user
    if (isNaN(idx)) return sock.sendMessage(jid, { text: '❌ Format: *removebank <number>* (see it in *settings*)' });
    try {
      await settingsRepo.removeBankAccount(idx);
      return sock.sendMessage(jid, { text: `✅ Bank account #${idx + 1} removed.` });
    } catch (err) {
      return sock.sendMessage(jid, { text: `❌ ${err.message}` });
    }
  }

  if (lower.startsWith('setprice ')) {
    const price = parseInt(trimmed.split(' ')[1].replace(/[^\d]/g, ''), 10);
    if (isNaN(price) || price <= 0) return sock.sendMessage(jid, { text: '❌ Format: *setprice 1000* (naira per day)' });
    await settingsRepo.setProPrice(price);
    return sock.sendMessage(jid, { text: `✅ Pro price set to ₦${price.toLocaleString()}/day.` });
  }

  if (lower.startsWith('approve receipt ')) {
    return approveReceipt(sock, jid, trimmed.split(' ')[2]);
  }
  if (lower.startsWith('reject receipt ')) {
    const parts = trimmed.split(' ');
    const id = parts[2];
    const reason = parts.slice(3).join(' ') || 'Payment could not be verified.';
    return rejectReceipt(sock, jid, id, reason);
  }
  if (lower.startsWith('approve ')) return approveListing(sock, jid, trimmed.split(' ')[1]);
  if (lower.startsWith('reject ')) {
    const parts = trimmed.split(' ');
    const id = parts[1];
    const reason = parts.slice(2).join(' ') || 'Does not meet our listing guidelines.';
    return rejectListing(sock, jid, id, reason);
  }
  if (lower.startsWith('sold ')) return markSold(sock, jid, trimmed.split(' ')[1]);

  return false; // not an admin command
}

async function showAdminHelp(sock, jid) {
  await sendButtons(
    sock, jid,
    `🛠 *Admin Commands*\n\n` +
      `*pending* — listings awaiting review\n` +
      `*approve <id>* / *reject <id> [reason]* — review a listing\n` +
      `*listings* — active listings\n` +
      `*sold <id>* — mark a listing sold\n` +
      `*receipts* — pending payment receipts\n` +
      `*approve receipt <id>* / *reject receipt <id> [reason]* — review a payment\n` +
      `*settings* — view bank/pricing settings\n` +
      `*setbank Bank Name | Account Number | Account Name* — add a bank account\n` +
      `*removebank <number>* — remove a bank account (see number in *settings*)\n` +
      `*setprice <amount>* — set Pro price per day (₦)\n` +
      `*find <ref>* — look up a product by its ID (e.g. find EGF-4821)`,
    [{ id: 'admin_search_product', title: '🔍 Search Product' }]
  );
}

// Looks up a product by its short ref code (e.g. "EGF-4821") and replies
// with the full internal view — this is the ONE place seller phone/email
// are sent anywhere, and it only ever goes to the admin's own WhatsApp
// chat, never over the public HTTP API.
async function searchProductByRef(sock, jid, ref) {
  const cleanRef = (ref || '').trim().toUpperCase();
  if (!cleanRef) {
    return sock.sendMessage(jid, { text: '❌ Please send a Product ID, e.g. EGF-4821' });
  }

  const product = await productRepo.getProductByRef(cleanRef);
  if (!product) {
    return sock.sendMessage(jid, { text: `❌ No product found for *${cleanRef}*.` });
  }

  const seller = product.seller_whatsapp ? await userRepo.getUserByPhone(product.seller_whatsapp) : null;
  const statusLabel = { active: 'Active', pending: 'Pending', rejected: 'Rejected', sold: 'Sold' }[product.status] || product.status;
  const floorLine = product.negotiable && product.lowest_price ? ` (Floor: ₦${Number(product.lowest_price).toLocaleString()})` : '';

  const msg =
    `📦 *${product.name}*\n` +
    `Price: ₦${Number(product.selling_price).toLocaleString()}${floorLine}\n` +
    `Status: ${statusLabel}\n\n` +
    `👤 Seller: ${seller?.name || 'Unknown'}\n` +
    `📱 WhatsApp: ${product.seller_whatsapp || 'N/A'}\n` +
    `📧 Email: ${seller?.email || 'N/A'}\n\n` +
    `View full listing: ${LISTING_BASE_URL}?product=${product.ref_code}`;

  await sock.sendMessage(jid, { text: msg });
}

async function showPending(sock, jid) {
  const pending = await productRepo.getPendingProducts();
  if (pending.length === 0) return sock.sendMessage(jid, { text: '✅ No listings pending review.' });
  let msg = `📋 *Pending Listings* (${pending.length})\n\n`;
  pending.forEach(p => { msg += `📦 ${p.name} — ₦${Number(p.selling_price).toLocaleString()}\n🆔 ${p.id}\n\n`; });
  msg += `Reply *approve <id>* or *reject <id> [reason]*`;
  await sock.sendMessage(jid, { text: msg });
}

async function showActiveListings(sock, jid) {
  const active = await productRepo.getActiveProductsAll();
  if (active.length === 0) return sock.sendMessage(jid, { text: '📭 No active listings.' });
  let msg = `📋 *Active Listings* (${active.length})\n\n`;
  active.forEach(p => { msg += `📦 ${p.name} — ₦${Number(p.selling_price).toLocaleString()}${p.is_premium ? ' 💎' : ''}\n🆔 ${p.id}\n\n`; });
  msg += `Reply *sold <id>* to mark an item sold.`;
  await sock.sendMessage(jid, { text: msg });
}

async function approveListing(sock, jid, id) {
  const product = await productRepo.getProductById(id);
  if (!product) return sock.sendMessage(jid, { text: '❌ Listing not found.' });
  await productRepo.updateProduct(id, { status: 'active' });
  await sock.sendMessage(jid, { text: `✅ Approved: ${product.name}` });

  if (product.seller_whatsapp) {
    const sellerJid = `${product.seller_whatsapp.replace(/\D/g, '')}@s.whatsapp.net`;
    const liveLink = product.ref_code ? `\n\n🔗 View it live: https://eduglobalforge.com/buy-items/?product=${product.ref_code}` : '';
    await sock.sendMessage(sellerJid, { text: `🎉 Your listing *${product.name}* has been approved and is now live!${liveLink}` }).catch(() => {});
  }
}

async function rejectListing(sock, jid, id, reason) {
  const product = await productRepo.getProductById(id);
  if (!product) return sock.sendMessage(jid, { text: '❌ Listing not found.' });
  await productRepo.updateProduct(id, { status: 'rejected', reject_reason: reason });
  await deleteFiles(product.media, 'product-media').catch(() => {});
  await sock.sendMessage(jid, { text: `🚫 Rejected: ${product.name}` });

  if (product.seller_whatsapp) {
    const sellerJid = `${product.seller_whatsapp.replace(/\D/g, '')}@s.whatsapp.net`;
    await sock.sendMessage(sellerJid, {
      text: `❌ Your listing *${product.name}* was not approved.\nReason: ${reason}\n\nYou're welcome to submit a revised listing anytime.`
    }).catch(() => {});
  }
}

async function markSold(sock, jid, id) {
  const product = await productRepo.getProductById(id);
  if (!product) return sock.sendMessage(jid, { text: '❌ Listing not found.' });
  await productRepo.updateProduct(id, { status: 'sold', sold_at: new Date().toISOString() });
  await sock.sendMessage(jid, { text: `✅ Marked sold: ${product.name}` });

  if (product.seller_whatsapp) {
    const sellerJid = `${product.seller_whatsapp.replace(/\D/g, '')}@s.whatsapp.net`;
    await sock.sendMessage(sellerJid, { text: `🎉 Your listing *${product.name}* has been marked as sold. Congrats!` }).catch(() => {});
  }
}

async function showPendingReceipts(sock, jid) {
  const receipts = await paymentRepo.getPendingReceipts();
  if (receipts.length === 0) return sock.sendMessage(jid, { text: '✅ No payment receipts pending review.' });
  let msg = `🧾 *Pending Receipts* (${receipts.length})\n\n`;
  for (const r of receipts) {
    const product = await productRepo.getProductById(r.product_id);
    msg += `📦 ${product ? product.name : r.product_id}\n💰 ₦${Number(r.amount).toLocaleString()} (${r.days} days)\n🆔 ${r.id}\n\n`;
  }
  msg += `Reply *approve receipt <id>* or *reject receipt <id> [reason]*`;
  await sock.sendMessage(jid, { text: msg });
}

async function approveReceipt(sock, jid, id) {
  const receipt = await paymentRepo.getReceiptById(id);
  if (!receipt) return sock.sendMessage(jid, { text: '❌ Receipt not found.' });

  await paymentRepo.updateReceipt(id, { status: 'approved' });
  await deleteFiles([receipt.receipt_url], 'payment-receipts').catch(() => {});
  const expiresAt = new Date(Date.now() + receipt.days * 24 * 60 * 60 * 1000).toISOString();
  await productRepo.updateProduct(receipt.product_id, { is_premium: true, premium_expires_at: expiresAt });

  await sock.sendMessage(jid, { text: `✅ Payment approved — listing pinned for ${receipt.days} days.` });
  await sock.sendMessage(receipt.user_whatsapp_id, {
    text: `🎉 Payment confirmed! Your listing is now pinned as *Pro* for ${receipt.days} days.`
  }).catch(() => {});
}

async function rejectReceipt(sock, jid, id, reason) {
  const receipt = await paymentRepo.getReceiptById(id);
  if (!receipt) return sock.sendMessage(jid, { text: '❌ Receipt not found.' });

  await paymentRepo.updateReceipt(id, { status: 'rejected', reject_reason: reason });
  await deleteFiles([receipt.receipt_url], 'payment-receipts').catch(() => {});
  await sock.sendMessage(jid, { text: `🚫 Receipt rejected.` });
  await sock.sendMessage(receipt.user_whatsapp_id, {
    text: `❌ We couldn't verify your payment.\nReason: ${reason}\n\nPlease double-check the transfer and resend a clear screenshot, or contact admin directly.`
  }).catch(() => {});
}

async function showSettings(sock, jid) {
  const settings = await settingsRepo.getSettings();
  let msg = `⚙️ *Settings*\n\nPro price/day: ₦${settings.pro_price_per_day}\n\n*Bank Accounts:*\n`;
  const banks = settings.bank_accounts || [];
  if (banks.length === 0) msg += 'None set — add rows to the `bank_accounts` column in Supabase.\n';
  banks.forEach((b, i) => { msg += `${i + 1}. ${b.bankName} — ${b.accountNumber} (${b.accountName})\n`; });
  await sock.sendMessage(jid, { text: msg });
}

module.exports = { isAdmin, handleAdminCommand };
