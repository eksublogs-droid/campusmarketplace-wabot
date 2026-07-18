const productRepo = require('../repos/productRepo');
const { setSession, updateSession, getSession, clearSession } = require('../utils/session');
const { uploadBuffer } = require('../utils/media');
const { sendSmartMenu, sendFlow, sendCtaUrl } = require('../utils/interactive');

// Steps that support a short fixed set of choices now show reply
// buttons/list options (auto-picked by count) instead of asking the user to
// free-type a value — but typing still works too (a typed value that isn't
// one of the numbered ids is used as-is), so nothing breaks for anyone
// whose client doesn't render the interactive UI.
const STEPS = [
  { step: 'sell_name', field: 'name', question: '📦 What are you selling? (item name)' },
  {
    step: 'sell_category', field: 'category', question: '🗂 Pick a category (or type your own):',
    options: ['Electronics', 'Fashion', 'Books', 'Home & Living', 'Other']
  },
  {
    step: 'sell_condition', field: 'condition', question: '⚙️ What condition is it in?',
    options: ['New', 'Fairly Used', 'Used - Faulty']
  },
  { step: 'sell_price', field: 'selling_price', question: '💰 Selling price? (numbers only, e.g. 15000)', numeric: true },
  { step: 'sell_description', field: 'description', question: '📝 Brief description of the item?' },
  { step: 'sell_state', field: 'state', question: '📍 What state are you in?' },
  { step: 'sell_city', field: 'city', question: '🏙 What city/town?' },
  { step: 'sell_whatsapp', field: 'seller_whatsapp', question: '📱 WhatsApp number for buyers to reach you (with country code, no +)?' },
  { step: 'sell_media', field: null, question: '📸 Send 1-5 photos of the item now (send them one at a time). Reply *done* when finished.' }
];

// Sends a step's question, using reply buttons/list when it has a fixed
// options set, plain text otherwise.
async function askStep(sock, jid, stepDef) {
  if (stepDef.options) {
    return sendSmartMenu(
      sock, jid, stepDef.question,
      stepDef.options.map((label, i) => ({ id: String(i + 1), label })),
      { footer: 'Or just type your own answer.' }
    );
  }
  return sock.sendMessage(jid, { text: stepDef.question });
}

async function startSellFlow(sock, jid, user) {
  updateSession(jid, { sellData: {}, sellMedia: [] });

  // Preferred path: the mobile-friendly "one page, all fields" form, now
  // hosted on eduglobalforge.com (a WordPress Custom HTML page) instead of
  // this server's own /public/sell-form.html. The form itself calls back
  // to THIS server's /api/upload-media and /api/submit-listing (that's
  // what the CORS block in index.js is for).
  const SELL_FORM_URL = 'https://eduglobalforge.com/sell-item';
  if (SELL_FORM_URL) {
    const phone = jid.split('@')[0];
    const formUrl = `${SELL_FORM_URL}?userId=${encodeURIComponent(phone)}`;
    const sent = await sendCtaUrl(
      sock, jid,
      '📦 Let\'s list your item! Fill in the quick form below — everything on one page.',
      'Start Selling',
      formUrl
    );
    if (sent) {
      setSession(jid, 'sell_flow_pending');
      return;
    }
  }

  // Optional: if a "Sell an Item" WhatsApp Flow is published and its ID is
  // set in WA_SELL_FLOW_ID, use it for a native multi-step form instead of
  // the chat Q&A below. If it's not configured (or the send fails), this
  // silently falls through to the original step-by-step conversation — the
  // Flow is a pure upgrade, never a requirement.
  const flowId = process.env.WA_SELL_FLOW_ID;
  if (flowId) {
    // WA_SELL_FLOW_MODE controls whether this is sent as a draft-testing
    // send or a real published send. Meta rejects draft Flows sent without
    // mode: 'draft' with "Integrity requirements not met" — so default to
    // 'draft' here (safe for testing) and switch the env var to
    // 'published' only once the Flow is actually published in WA Manager.
    const flowMode = process.env.WA_SELL_FLOW_MODE || 'draft';
    const flowToken = `sell_${user.id}_${Date.now()}`;
    updateSession(jid, { sellFlowToken: flowToken });
    const launched = await sendFlow(sock, jid, {
      flowId,
      flowToken,
      mode: flowMode,
      bodyText: '📦 Let\'s list your item! Fill in the quick form below.',
      cta: 'Start Selling'
    });
    if (launched) {
      setSession(jid, 'sell_flow_pending');
      return;
    }
  }

  setSession(jid, STEPS[0].step);
  await askStep(sock, jid, STEPS[0]);
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

  // A reply-button/list id ("1","2"...) maps back to its option label; any
  // other text (typed freely, or the "Other" fallback) is used as-is.
  if (stepDef.options) {
    const n = parseInt(value, 10);
    if (!isNaN(n) && n >= 1 && n <= stepDef.options.length) value = stepDef.options[n - 1];
  }

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
  await askStep(sock, jid, STEPS[nextIdx]);
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
    const fileId = await uploadBuffer(buffer, mimeType, 'product-media');
    media.push({ file_id: fileId, type: mimeType.includes('video') ? 'video' : 'photo' });
    updateSession(jid, { sellMedia: media });
    await sock.sendMessage(jid, { text: `✅ Media ${media.length}/5 received. Send more or reply *done*.` });
  } catch (err) {
    console.error('Media upload error:', err.message);
    await sock.sendMessage(jid, { text: '❌ Upload failed, please try sending that again.' });
  }
  return true;
}

// Called by index.js when a "Sell an Item" Flow submission (nfm_reply)
// comes back. The Flow's field names must match: name, category,
// condition, selling_price, description, state, city, seller_whatsapp
// (see flows/sell-item-flow.json). Flows can't reliably collect photo
// uploads, so we still collect those the normal way afterwards.
async function handleSellFlowSubmission(sock, jid, flowData, user) {
  const sellData = {
    name: flowData.name,
    category: flowData.category,
    condition: flowData.condition,
    selling_price: parseInt(String(flowData.selling_price || '').replace(/[^\d]/g, ''), 10),
    description: flowData.description,
    state: flowData.state,
    city: flowData.city,
    seller_whatsapp: flowData.seller_whatsapp
  };

  if (!sellData.name || !sellData.selling_price) {
    await sock.sendMessage(jid, { text: '❌ That form submission looked incomplete — let\'s try the questions here instead.' });
    setSession(jid, STEPS[0].step);
    return askStep(sock, jid, STEPS[0]);
  }

  updateSession(jid, { sellData, sellMedia: [] });
  setSession(jid, 'sell_media');
  await sock.sendMessage(jid, {
    text: `✅ Got it, *${sellData.name}*! Now send 1-5 photos of the item (one at a time). Reply *done* when finished.`
  });
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

  const priceStr = `₦${Number(product.selling_price).toLocaleString()}`;
  const galleryLink = `https://eduglobalforge.com/sell-item/summary?id=${product.id}`;

  await sock.sendMessage(jid, {
    text:
      `✅ *Listing submitted for review!*\n\n` +
      `📦 *Item:* ${product.name}\n` +
      `🗂 *Category:* ${product.category || '-'}\n` +
      `⚙️ *Condition:* ${product.condition || '-'}\n` +
      `💰 *Price:* ${priceStr}\n` +
      `📝 *Description:* ${product.description || '-'}\n` +
      `📍 *Location:* ${product.city}, ${product.state}\n` +
      `🔗 *See all your photos:* ${galleryLink}\n\n` +
      `Our team will review it shortly. You'll get a message here once it's approved. Reply *menu* to return.`
  });

  const adminJid = `${process.env.ADMIN_WHATSAPP}@s.whatsapp.net`;
  const notifyText =
    `🆕 *New Listing Pending Review*\n\n` +
    `📦 *Item:* ${product.name}\n` +
    `🗂 *Category:* ${product.category || '-'}\n` +
    `⚙️ *Condition:* ${product.condition || '-'}\n` +
    `💰 *Price:* ${priceStr}\n` +
    `📝 *Description:* ${product.description || '-'}\n` +
    `📍 *Location:* ${product.city}, ${product.state}\n` +
    `👤 *Seller:* ${user.name} (${user.phone})\n` +
    `🖼 *Photos:* ${sellMedia.length}\n` +
    `🔗 *See all photos:* ${galleryLink}`;

  // Reply buttons let the admin approve/reject with a tap — the button
  // `id` is the exact same text command handlers/admin.js already parses,
  // so no admin.js changes were needed for this to work.
  await sock.sendMessage(adminJid, {
    buttons: {
      body: notifyText,
      footer: 'Tap to review, or type the command manually.',
      buttons: [
        { id: `approve ${product.id}`, title: '✅ Approve' },
        { id: `reject ${product.id}`, title: '❌ Reject' }
      ]
    }
  }).catch(() => {});

  setSession(jid, 'main_menu');
}

module.exports = { startSellFlow, handleSellTextStep, handleSellMedia, handleSellFlowSubmission, STEPS };
