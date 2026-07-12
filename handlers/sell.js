const productRepo = require('../repos/productRepo');
const { setSession, updateSession, getSession, clearSession } = require('../utils/session');
const { uploadBuffer } = require('../utils/media');

const STEPS = [
  { step: 'sell_name', field: 'name', question: '📦 What are you selling? (item name)' },
  { step: 'sell_category', field: 'category', question: '🗂 Category? (e.g. Electronics, Fashion, Books)' },
  { step: 'sell_condition', field: 'condition', question: '⚙️ Condition? (e.g. Fairly Used, New, Used - Faulty)' },
  { step: 'sell_price', field: 'selling_price', question: '💰 Selling price? (numbers only, e.g. 15000)', numeric: true },
  { step: 'sell_description', field: 'description', question: '📝 Brief description of the item?' },
  { step: 'sell_state', field: 'state', question: '📍 What state are you in?' },
  { step: 'sell_city', field: 'city', question: '🏙 What city/town?' },
  { step: 'sell_whatsapp', field: 'seller_whatsapp', question: '📱 WhatsApp number for buyers to reach you (with country code, no +)?' },
  { step: 'sell_media', field: null, question: '📸 Send 1-5 photos of the item now (send them one at a time). Reply *done* when finished.' }
];

async function startSellFlow(sock, jid, user) {
  updateSession(jid, { sellData: {}, sellMedia: [] });
  setSession(jid, STEPS[0].step);
  await sock.sendMessage(jid, { text: STEPS[0].question });
}

function currentStepIndex(sessionStep) {
  return STEPS.findIndex(s => s.step === sessionStep);
}

async function handleSellTextStep(sock, jid, text, user) {
  const session = getSession(jid);
  const idx = currentStepIndex(session.step);
  if (idx === -1) return;
  const stepDef = STEPS[idx];

  if (stepDef.field === null) {
    if ((text || '').trim().toLowerCase() === 'done') {
      return finishSellFlow(sock, jid, user);
    }
    return sock.sendMessage(jid, { text: '📸 Send a photo, or reply *done* when finished.' });
  }

  let value = (text || '').trim();
  if (stepDef.numeric) {
    const n = parseInt(value.replace(/[^\d]/g, ''), 10);
    if (isNaN(n) || n <= 0) return sock.sendMessage(jid, { text: '❌ Please enter a valid number.' });
    value = n;
  }

  const sellData = (session.data && session.data.sellData) || {};
  sellData[stepDef.field] = value;
  updateSession(jid, { sellData });

  const nextIdx = idx + 1;
  if (nextIdx >= STEPS.length) return finishSellFlow(sock, jid, user);

  setSession(jid, STEPS[nextIdx].step);
  await sock.sendMessage(jid, { text: STEPS[nextIdx].question });
}

async function handleSellMedia(sock, jid, buffer, mimeType) {
  const session = getSession(jid);
  if (!session || session.step !== 'sell_media') return false;

  const media = (session.data && session.data.sellMedia) || [];
  if (media.length >= 5) {
    await sock.sendMessage(jid, { text: '⚠️ Max 5 photos/videos reached. Reply *done* to submit.' });
    return true;
  }

  try {
    const url = await uploadBuffer(buffer, mimeType, 'product-media');
    media.push({ url, type: mimeType.includes('video') ? 'video' : 'photo' });
    updateSession(jid, { sellMedia: media });
    await sock.sendMessage(jid, { text: `✅ Media ${media.length}/5 received. Send more or reply *done*.` });
  } catch (err) {
    console.error('Media upload error:', err.message);
    await sock.sendMessage(jid, { text: '❌ Upload failed, please try sending that again.' });
  }
  return true;
}

async function finishSellFlow(sock, jid, user) {
  const session = getSession(jid);
  const sellData = (session.data && session.data.sellData) || {};
  const sellMedia = (session.data && session.data.sellMedia) || [];

  if (sellMedia.length === 0) {
    return sock.sendMessage(jid, { text: '📸 Please send at least 1 photo before finishing.' });
  }

  const product = await productRepo.createProduct({
    ...sellData,
    media: sellMedia,
    posted_by: 'user',
    status: 'pending'
  });
  clearSession(jid);

  await sock.sendMessage(jid, {
    text:
      `✅ *Listing submitted for review!*\n\n` +
      `📦 ${product.name}\n💰 ₦${Number(product.selling_price).toLocaleString()}\n\n` +
      `Our team will review it shortly. You'll get a message here once it's approved. Reply *menu* to return.`
  });

  const adminJid = `${process.env.ADMIN_WHATSAPP}@s.whatsapp.net`;
  await sock.sendMessage(adminJid, {
    text:
      `🆕 *New Listing Pending Review*\n\n` +
      `📦 ${product.name}\n💰 ₦${Number(product.selling_price).toLocaleString()}\n📍 ${product.city}, ${product.state}\n` +
      `👤 Seller: ${user.name} (${user.phone})\n\n` +
      `Reply *approve ${product.id}* or *reject ${product.id}* to review.`
  }).catch(() => {});

  setSession(jid, 'main_menu');
}

module.exports = { startSellFlow, handleSellTextStep, handleSellMedia, STEPS };
