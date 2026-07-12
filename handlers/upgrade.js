const productRepo = require('../repos/productRepo');
const settingsRepo = require('../repos/settingsRepo');
const paymentRepo = require('../repos/paymentRepo');
const { setSession, updateSession, getSession, clearSession } = require('../utils/session');
const { uploadBuffer } = require('../utils/media');

// Step 1: show the user their own listings, ask which to upgrade
async function startUpgradeFlow(sock, jid, user) {
  const products = await productRepo.getProductsBySellerPhone(user.phone);
  const eligible = products.filter(p => p.status === 'active' && !p.is_premium);

  if (eligible.length === 0) {
    setSession(jid, 'main_menu');
    return sock.sendMessage(jid, { text: '📭 You have no active listings eligible for a Pro upgrade right now.' });
  }

  let msg = `💎 *Upgrade a Listing to Pro*\n\nPro listings are pinned to the top of Buy results.\n\n`;
  eligible.forEach((p, i) => {
    msg += `${i + 1}️⃣ ${p.name} — ₦${Number(p.selling_price).toLocaleString()}\n`;
  });
  msg += `\nReply with a number to choose, or *0* to cancel.`;

  updateSession(jid, { upgradeProductIds: eligible.map(p => p.id) });
  setSession(jid, 'upgrade_select_product');
  await sock.sendMessage(jid, { text: msg });
}

async function handleUpgradeSelectProduct(sock, jid, text, user) {
  const session = getSession(jid);
  const ids = (session.data && session.data.upgradeProductIds) || [];
  const trimmed = (text || '').trim();

  if (trimmed === '0') {
    clearSession(jid);
    return require('./user').showMainMenu(sock, jid, user);
  }

  const n = parseInt(trimmed, 10);
  if (isNaN(n) || n < 1 || n > ids.length) {
    return sock.sendMessage(jid, { text: '❌ Invalid choice. Reply with a listed number or *0* to cancel.' });
  }

  updateSession(jid, { upgradeProductId: ids[n - 1] });
  setSession(jid, 'upgrade_select_days');
  await sock.sendMessage(jid, { text: '📅 How many days should it stay pinned? (e.g. 7, 14, 30):' });
}

async function handleUpgradeSelectDays(sock, jid, text, user) {
  const days = parseInt((text || '').trim(), 10);
  if (isNaN(days) || days <= 0) return sock.sendMessage(jid, { text: '❌ Enter a valid number of days.' });

  const settings = await settingsRepo.getSettings();
  const amount = days * Number(settings.pro_price_per_day);
  updateSession(jid, { upgradeDays: days, upgradeAmount: amount });

  const activeBanks = (settings.bank_accounts || []).filter(b => b.active !== false);
  let bankMsg = '';
  if (activeBanks.length === 0) {
    bankMsg = '⚠️ No bank account is set up yet — please contact admin directly.';
  } else {
    activeBanks.forEach(b => {
      bankMsg += `🏦 ${b.bankName}\n🔢 ${b.accountNumber}\n👤 ${b.accountName}\n\n`;
    });
  }

  setSession(jid, 'upgrade_awaiting_receipt');
  await sock.sendMessage(sock ? jid : jid, {
    text:
      `💰 *${days} day(s) Pro listing = ₦${amount.toLocaleString()}*\n\n` +
      `Please transfer the exact amount to:\n\n${bankMsg}` +
      `Once you've paid, *send a screenshot of the transaction receipt here* and we'll review it.`
  });
}

async function handleUpgradeReceiptMedia(sock, jid, buffer, mimeType, user) {
  const session = getSession(jid);
  if (!session || session.step !== 'upgrade_awaiting_receipt') return false;

  const productId = session.data.upgradeProductId;
  const days = session.data.upgradeDays;
  const amount = session.data.upgradeAmount;

  try {
    const url = await uploadBuffer(buffer, mimeType, 'payment-receipts');
    const receipt = await paymentRepo.createReceipt({
      user_whatsapp_id: jid,
      product_id: productId,
      days,
      amount,
      receipt_url: url,
      status: 'pending'
    });

    clearSession(jid);
    setSession(jid, 'main_menu');
    await sock.sendMessage(jid, {
      text: `✅ Receipt received! We'll verify your payment and pin your listing shortly.`
    });

    const product = await productRepo.getProductById(productId);
    const adminJid = `${process.env.ADMIN_WHATSAPP}@s.whatsapp.net`;
    await sock.sendMessage(adminJid, {
      image: { url },
      caption:
        `🧾 *Payment Receipt — Pro Upgrade*\n\n` +
        `📦 ${product ? product.name : productId}\n` +
        `📅 ${days} day(s) — ₦${Number(amount).toLocaleString()}\n` +
        `👤 ${user.name} (${user.phone})\n\n` +
        `Reply *approve receipt ${receipt.id}* or *reject receipt ${receipt.id} [reason]*`
    }).catch(() => {});
  } catch (err) {
    console.error('Receipt upload error:', err.message);
    await sock.sendMessage(jid, { text: '❌ Could not process that image, please try sending it again.' });
  }
  return true;
}

module.exports = {
  startUpgradeFlow, handleUpgradeSelectProduct, handleUpgradeSelectDays, handleUpgradeReceiptMedia
};
