const productRepo = require('../repos/productRepo');
const settingsRepo = require('../repos/settingsRepo');
const paymentRepo = require('../repos/paymentRepo');
const { deleteFiles } = require('../utils/media');

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
  await sock.sendMessage(jid, {
    text:
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
      `*setprice <amount>* — set Pro price per day (₦)`
  });
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
    await sock.sendMessage(sellerJid, { text: `🎉 Your listing *${product.name}* has been approved and is now live!` }).catch(() => {});
  }
}

async function rejectListing(sock, jid, id, reason) {
  const product = await productRepo.getProductById(id);
  if (!product) return sock.sendMessage(jid, { text: '❌ Listing not found.' });
  await productRepo.updateProduct(id, { status: 'rejected' });
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
