require('dotenv').config();
const crypto = require('crypto');
const express = require('express');

const waCloudApi = require('./utils/waCloudApi');
const { getSession, setSession, clearSession } = require('./utils/session');
const { parseMenuChoice } = require('./utils/menu');
const botStatus = require('./utils/botStatus');

const userRepo = require('./repos/userRepo');
const statsRepo = require('./repos/statsRepo');
const productRepo = require('./repos/productRepo');
const multer = require('multer');
const uploadNone = multer();

const {
  askName, handleDetailsInput, handleConfirmDetails,
  showMainMenu, handleMainMenuChoice, handleResetTestUser, handleBrowsingChoice,
  handleViewingProductChoice, MAIN_OPTIONS
} = require('./handlers/user');
const { handleSellTextStep, handleSellMedia, handleSellFlowSubmission } = require('./handlers/sell');
const {
  handleUpgradeSelectProduct, handleUpgradeSelectDays, handleUpgradeReceiptMedia
} = require('./handlers/upgrade');
const { isAdmin, handleAdminCommand } = require('./handlers/admin');
const { checkExpiringProPlans, demoteExpiredProPlans, deleteOldSoldProducts } = require('./utils/cron');

const app = express();

// FIX: Meta signs every webhook POST body with your App Secret (X-Hub-Signature-256).
// We need the raw request bytes to verify that signature, so capture them
// here before express.json() parses the body — verifying against the
// already-parsed/re-stringified object can mismatch and false-reject valid
// webhooks.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(__dirname + '/public'));

// CORS: the sell form lives on eduglobalforge.com (a different origin from
// this Railway server), so its browser fetch() calls to /api/upload-media
// and /api/submit-listing need these headers or the browser blocks them.
// No 'cors' npm package used on purpose — avoids touching package-lock.json.
const ALLOWED_ORIGINS = [
  'https://eduglobalforge.com',
  'https://www.eduglobalforge.com'
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// A minimal `sock`-shaped object so every handler/repo call written against
// the old Baileys socket (sock.sendMessage, sock.sendPresenceUpdate, ...)
// keeps working completely unchanged.
const sock = {
  sendMessage: waCloudApi.sendMessage,
  sendMessageRaw: waCloudApi.sendMessageRaw,
  sendPresenceUpdate: waCloudApi.sendPresenceUpdate
};

function verifySignature(req) {
  const appSecret = process.env.WA_APP_SECRET;
  if (!appSecret) return true; // not configured — skip (warning already logged at boot)
  const signature = req.headers['x-hub-signature-256'];
  if (!signature || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (_) {
    return false; // length mismatch etc.
  }
}

function extractText(message) {
  if (message.type === 'text') return message.text?.body || '';
  if (message.type === 'button') return message.button?.text || message.button?.payload || '';
  if (message.type === 'interactive') {
    // Button/list replies carry the same `id` the numbered-text flow always
    // used, so they route through every existing handler/menu parser
    // unchanged. Flow submissions (nfm_reply) have no single "id" — those
    // are handled separately in handleIncomingMessage via extractFlowReply().
    return (
      message.interactive?.button_reply?.id ||
      message.interactive?.list_reply?.id ||
      ''
    );
  }
  if (message.type === 'image') return message.image?.caption || '';
  if (message.type === 'video') return message.video?.caption || '';
  return '';
}

// A completed WhatsApp Flow submission arrives as an interactive message of
// subtype `nfm_reply`, with the form's answers JSON-encoded as a string.
// Returns the parsed object, or null if this message isn't a flow reply.
function extractFlowReply(message) {
  const raw = message.interactive?.nfm_reply?.response_json;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse flow response_json:', err.message);
    return null;
  }
}

function mimeTypeOf(message) {
  return message.image?.mime_type || message.video?.mime_type || 'image/jpeg';
}

async function handleIncomingMessage(message) {
  const phone = message.from; // bare phone, e.g. "2348012345678"
  const jid = `${phone}@s.whatsapp.net`;
  const text = extractText(message).trim();

  // Mark read immediately + light typing indicator, closest Cloud API
  // equivalent to Baileys' instant read receipt + composing presence.
  waCloudApi.markAsRead(message.id, true).catch(() => {});

  const { user } = await userRepo.getOrCreateUser(jid, phone);

  const registered = !!(user.name && user.email_submitted);

  const lower = text.toLowerCase();
  if (lower === 'menu' || lower === 'cancel') {
    clearSession(jid);
    // Only a registered user has a main menu to return to — mid-onboarding,
    // "menu"/"cancel" just restarts the name+email prompt instead.
    return registered ? showMainMenu(sock, jid, user) : askName(sock, jid);
  }

  // Admin command layer (checked first, admin can still browse/sell like anyone else)
  if (isAdmin(phone)) {
    const handled = await handleAdminCommand(sock, jid, text);
    if (handled) return;
  }

  // ===== registration gate =====
  if (!registered) {
    const regSession = getSession(jid);
    if (regSession && regSession.step === 'confirming_details') return handleConfirmDetails(sock, jid, text, user);
    if (regSession && regSession.step === 'awaiting_details') return handleDetailsInput(sock, jid, text, user);
    return askName(sock, jid); // first contact, or a lost/expired session
  }

  const session = getSession(jid);

  // ===== WhatsApp Flow submissions =====
  // Only meaningful if a handler actually launched a Flow (see
  // handlers/sell.js startSellFlow) and is waiting on it — if a flow reply
  // shows up with no matching session state, it's ignored rather than
  // crashing the pipeline.
  if (message.type === 'interactive') {
    const flowData = extractFlowReply(message);
    if (flowData) {
      if (session && session.step === 'sell_flow_pending') {
        return handleSellFlowSubmission(sock, jid, flowData, user);
      }
      return; // stray/expired flow reply, nothing to do
    }
  }

  // ===== media (photos/videos) =====
  if (message.type === 'image' || message.type === 'video') {
    if (session && session.step === 'sell_media') {
      const mediaId = message.image?.id || message.video?.id;
      const buffer = await waCloudApi.downloadMedia(mediaId);
      await handleSellMedia(sock, jid, buffer, mimeTypeOf(message));
      return;
    }
    if (session && session.step === 'upgrade_awaiting_receipt') {
      const mediaId = message.image?.id || message.video?.id;
      const buffer = await waCloudApi.downloadMedia(mediaId);
      await handleUpgradeReceiptMedia(sock, jid, buffer, mimeTypeOf(message), user);
      return;
    }
    return; // stray media, ignore
  }

  // ===== route by session step =====
  if (!session || session.step === 'main_menu' || !session.step) {
    if (text.trim() === 'reset_test_user') return handleResetTestUser(sock, jid, user);
    const idx = parseMenuChoice(text, MAIN_OPTIONS.length);
    if (idx === -1) return showMainMenu(sock, jid, user);
    return handleMainMenuChoice(sock, jid, idx, user);
  }

  if (session.step === 'browsing') return handleBrowsingChoice(sock, jid, text, user);
  if (session.step === 'viewing_product') return handleViewingProductChoice(sock, jid, text, user);
  if (session.step.startsWith('sell_')) return handleSellTextStep(sock, jid, text, user);
  if (session.step === 'upgrade_select_product') return handleUpgradeSelectProduct(sock, jid, text, user);
  if (session.step === 'upgrade_select_days') return handleUpgradeSelectDays(sock, jid, text, user);
  if (session.step === 'upgrade_awaiting_receipt') {
    return sock.sendMessage(jid, { text: '📸 Please send the payment receipt as a photo.' });
  }

  return showMainMenu(sock, jid, user);
}

// ===== Meta webhook =====

// GET: Meta's one-time verification handshake when you set the Callback URL.
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    console.log('✅ Webhook verified.');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST: actual message/status events.
app.post('/webhook', async (req, res) => {
  // Always ack fast — Meta retries aggressively on non-200/timeout.
  res.sendStatus(200);

  if (!verifySignature(req)) {
    console.error('Webhook signature verification failed — ignoring payload.');
    return;
  }

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    if (!value) return;

    const messages = value.messages || [];
    const statuses = value.statuses || [];

    for (const s of statuses) {
      if (s.status === 'failed') {
        console.error('WhatsApp delivery failed:', JSON.stringify(s.errors || s));
      }
    }

    for (const message of messages) {
      if (message.from === undefined) continue;
      handleIncomingMessage(message).catch((err) => {
        console.error('Message handling error:', err instanceof Error ? err.message : err);
      });
    }
  } catch (err) {
    console.error('Webhook processing error:', err instanceof Error ? err.message : err);
  }
});

// ===== Dashboard API =====

app.get('/api/status', async (req, res) => {
  const status = await botStatus.getStatus();
  res.json(status);
});

app.get('/api/stats', async (req, res) => {
  try {
    const stats = await statsRepo.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Admin user panel (for clearing test users without SQL) =====
app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/public/admin.html');
});

// Protected by ADMIN_PANEL_KEY env var, normally sent as an 'x-admin-key'
// header (keeps the password out of the URL/browser history). Also accepts
// ?key= as a query param, purely so routes meant to be visited directly
// from a phone browser (e.g. /api/admin/sync-flow) work without needing
// custom headers — existing header-based calls are unaffected.
function checkAdminKey(req, res) {
  const expected = process.env.ADMIN_PANEL_KEY;
  if (!expected) {
    res.status(500).json({ error: 'ADMIN_PANEL_KEY not set on the server' });
    return false;
  }
  const provided = req.headers['x-admin-key'] || req.query.key;
  if (provided !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.get('/api/admin/users', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const users = await userRepo.listUsers();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:phone', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    await userRepo.deleteUserByPhone(req.params.phone);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Syncs flows/sell-item-flow.json to Meta as a published WhatsApp Flow.
// Visit from your phone browser: /api/admin/sync-flow?key=YOUR_ADMIN_PANEL_KEY
const { syncFlow } = require('./flows/syncFlowCore');
const fs = require('fs');
const path = require('path');

app.get('/api/admin/sync-flow', async (req, res) => {
  if (!checkAdminKey(req, res)) return;
  try {
    const jsonPath = path.join(__dirname, 'flows', 'sell-item-flow.json');
    const flowJson = fs.readFileSync(jsonPath, 'utf8');
    JSON.parse(flowJson); // fail fast if the JSON on disk is broken

    const result = await syncFlow({
      token: process.env.WA_ACCESS_TOKEN,
      wabaId: process.env.WA_WABA_ID,
      flowJson,
      name: 'Sell an Item'
    });

    res.send(`<pre style="font-family:monospace;white-space:pre-wrap;padding:16px;line-height:1.5;">
${result.log.join('\n')}

Add this to your .env:
WA_SELL_FLOW_ID=${result.flowId}
</pre>`);
  } catch (err) {
    res.status(500).send(`<pre style="font-family:monospace;white-space:pre-wrap;padding:16px;color:#b00020;line-height:1.5;">
❌ ${err.message}
${err.validationErrors ? JSON.stringify(err.validationErrors, null, 2) : ''}
</pre>`);
  }
});

const supabase = require('./utils/supabaseClient');
const { uploadBuffer, resolveMediaUrl, uploadToWhatsApp } = require('./utils/media');
const LISTING_GALLERY_URL = 'https://eduglobalforge.com/pastquestions/listing';
const uploadMedia = multer(); // memory storage — no dest given, so files stay as req.file.buffer

// Receives one photo/video at a time from the sell form (WordPress or
// sell-form.html), uploads it straight to Supabase Storage, and returns
// its public URL. The form collects these URLs into preuploadedMedia and
// sends that along with /api/submit-listing below.
app.post('/api/upload-media', uploadMedia.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const fileId = await uploadBuffer(req.file.buffer, req.file.mimetype, 'product-media');
    const type = req.file.mimetype.includes('video') ? 'video' : 'photo';
    res.json({ ok: true, file_id: fileId, type });
  } catch (err) {
    console.error('upload-media error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Public, no-login endpoint that powers the WordPress gallery page
// ([egf_listing_gallery] shortcode). Only returns the item's own details
// and resolved photo/video links — never the seller's phone number.
app.get('/api/listing/:id', async (req, res) => {
  try {
    const product = await productRepo.getProductById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Listing not found' });

    const rawMedia = Array.isArray(product.media) ? product.media : [];
    const media = [];
    for (const m of rawMedia) {
      if (!m || !m.file_id) continue;
      try {
        const url = await resolveMediaUrl(m.file_id);
        media.push({ url, type: m.type === 'video' ? 'video' : 'photo' });
      } catch (_) {
        // one bad/expired file_id shouldn't break the whole gallery
      }
    }

    res.json({
      ok: true,
      name: product.name,
      status: product.status,
      reject_reason: product.reject_reason,
      category: product.category,
      subcategory: product.subcategory,
      brand: product.brand,
      condition: product.condition,
      selling_price: product.selling_price,
      original_price: product.original_price,
      negotiable: product.negotiable,
      lowest_price: product.lowest_price,
      description: product.description,
      used_duration: product.used_duration,
      has_defects: product.has_defects,
      defects_details: product.defects_details,
      was_repaired: product.was_repaired,
      repairs_details: product.repairs_details,
      reason_for_selling: product.reason_for_selling,
      state: product.state,
      capital: product.capital,
      lga: product.lga,
      city: product.city,
      door_dropoff: product.door_dropoff,
      door_pickup: product.door_pickup,
      receipt_available: product.receipt_available,
      warranty_remaining: product.warranty_remaining,
      warranty_duration: product.warranty_duration,
      original_packaging: product.original_packaging,
      media
    });
  } catch (err) {
    console.error('listing gallery error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Receives submissions from the sell form — now hosted on
// eduglobalforge.com (public/egf-sell-form.html was the older,
// Railway-hosted version). userId is the WhatsApp phone number passed in
// the form's URL (?userId=<phone>). Photos/videos are uploaded separately
// via /api/upload-media, which stores them in the Telegram channel and
// returns a file_id — we only receive those file_id + type pairs here,
// not the actual image bytes.
//
// The form (egf-sell-form-snippet.php) now sends the FULL 20-question
// field set, not just the original handful — see the boolStr/lines below
// for every field it can send. Extra columns (original_price, capital,
// lga, was_repaired, repairs_details, receipt_available,
// warranty_remaining, warranty_duration, original_packaging) must exist
// on the products table — see the ALTER TABLE block added to schema.sql.
app.post('/api/submit-listing', uploadNone.none(), async (req, res) => {
  try {
    const b = req.body;
    const phone = (b.userId || '').trim();
    if (!phone) return res.status(400).json({ error: 'Missing userId' });

    let media = [];
    try { media = JSON.parse(b.preuploadedMedia || '[]'); } catch (_) { media = []; }

    const sellingPrice = parseInt(String(b.sellingPrice || '').replace(/[^\d]/g, ''), 10);
    if (!b.itemTitle || !sellingPrice) {
      return res.status(400).json({ error: 'Missing required fields (itemTitle, sellingPrice)' });
    }

    const originalPrice = parseInt(String(b.originalPrice || '').replace(/[^\d]/g, ''), 10) || 0;
    const lowestPrice = parseInt(String(b.lowestPrice || '').replace(/[^\d]/g, ''), 10) || 0;
    const negotiable = String(b.negotiable) === 'true';
    const hasDefects = String(b.hasDefects) === 'true';
    const wasRepaired = String(b.wasRepaired) === 'true';
    const doorDropoff = String(b.doorDropoff) === 'true';
    const doorPickup = String(b.doorPickup) === 'true';

    const product = await productRepo.createProduct({
      name: b.itemTitle,
      category: b.category,
      subcategory: b.subcategory || '',
      brand: b.brand || '',
      condition: b.condition,
      selling_price: sellingPrice,
      original_price: originalPrice,
      negotiable,
      lowest_price: lowestPrice,
      description: b.description || '',
      used_duration: b.usedDuration || '',
      has_defects: hasDefects,
      defects_details: b.defectsDetails || '',
      was_repaired: wasRepaired,
      repairs_details: b.repairsDetails || '',
      reason_for_selling: b.reasonForSelling || '',
      state: b.state,
      capital: b.capital || '',
      lga: b.lga || '',
      city: b.city,
      door_dropoff: doorDropoff,
      door_pickup: doorPickup,
      receipt_available: b.receiptAvailable || '',
      warranty_remaining: b.warrantyRemaining || '',
      warranty_duration: b.warrantyDuration || '',
      original_packaging: b.originalPackaging || '',
      seller_whatsapp: phone,
      media,
      posted_by: 'user',
      status: 'pending'
    });

    const adminJid = `${process.env.ADMIN_WHATSAPP}@s.whatsapp.net`;
    const priceStr = `₦${Number(product.selling_price).toLocaleString()}`;
    const origPriceStr = originalPrice ? `₦${originalPrice.toLocaleString()}` : '-';
    const galleryLink = `${LISTING_GALLERY_URL}?id=${product.id}`;
    const yesNo = (v) => (v ? 'Yes' : 'No');

    // The first media item is sent as a real photo/video attachment (see
    // sendMediaPreview below) so the notification isn't text-only. Whatever
    // is left is described accurately here instead of a generic "see all
    // photos" line.
    const firstMedia = media[0] || null;
    const remainingMedia = media.slice(1);
    const remPhotos = remainingMedia.filter(m => m.type === 'photo').length;
    const remVideos = remainingMedia.filter(m => m.type === 'video').length;
    const remParts = [];
    if (remPhotos) remParts.push(`${remPhotos} photo${remPhotos > 1 ? 's' : ''}`);
    if (remVideos) remParts.push(`${remVideos} video${remVideos > 1 ? 's' : ''}`);
    const remainingLabel = remParts.join(' and ');
    const mediaLinkLine = remainingLabel
      ? `🔗 *See the remaining ${remainingLabel}:* ${galleryLink}`
      : `🔗 *View full listing details:* ${galleryLink}`;

    // Full detail block — shared by both the seller and admin messages.
    // Sent as a plain text message (4096-char limit), never as an
    // interactive "buttons" body (1024-char limit), since 20 fields of
    // detail routinely runs past that.
    const detailLines =
      `📦 *Item:* ${product.name}\n` +
      `🗂 *Category:* ${product.category || '-'} › ${product.subcategory || '-'}\n` +
      `🏷 *Brand:* ${product.brand || '-'}\n` +
      `⚙️ *Condition:* ${product.condition || '-'}\n` +
      `📝 *Description:* ${product.description || '-'}\n` +
      `💰 *Selling Price:* ${priceStr}\n` +
      `🧾 *Original Price:* ${origPriceStr}\n` +
      `🤝 *Negotiable:* ${yesNo(negotiable)}\n` +
      `${negotiable && lowestPrice ? `💵 *Lowest Price:* ₦${lowestPrice.toLocaleString()}\n` : ''}` +
      `⏳ *Used For:* ${product.used_duration || '-'}\n` +
      `⚠️ *Defects:* ${hasDefects ? (product.defects_details || 'Yes') : 'None'}\n` +
      `🔧 *Repairs:* ${wasRepaired ? (product.repairs_details || 'Yes') : 'None'}\n` +
      `❓ *Reason for Selling:* ${product.reason_for_selling || '-'}\n` +
      `📍 *Location:* ${product.city}, ${product.lga ? product.lga + ', ' : ''}${product.state}${product.capital ? ' (Capital: ' + product.capital + ')' : ''}\n` +
      `🚚 *Door Dropoff:* ${yesNo(doorDropoff)}\n` +
      `🤝 *Door Pickup:* ${yesNo(doorPickup)}\n` +
      `🧾 *Receipt Available:* ${product.receipt_available || 'Not answered'}\n` +
      `🛡 *Warranty:* ${product.warranty_remaining === 'yes' ? (product.warranty_duration || 'Yes') : (product.warranty_remaining || 'Not answered')}\n` +
      `📦 *Original Packaging:* ${product.original_packaging || 'Not answered'}\n` +
      `🖼 *Photos/Videos:* ${media.length} sent`;

    // Sends the first media item as an actual WhatsApp photo/video message
    // (not just a link). Downloads the bytes from Telegram ourselves, then
    // uploads them straight to WhatsApp's own Media API to get a media
    // `id` — that's what actually gets sent, instead of a `link` that Meta
    // would have to go fetch from Telegram on its own in the background
    // (that background fetch was the thing failing silently before: Meta
    // accepts the send with a 200 immediately, then reports the real
    // failure later via a `statuses` webhook — see /webhook above).
    // Non-fatal: a failure here shouldn't block the text notification.
    async function sendMediaPreview(jid, caption) {
      if (!firstMedia) return false;
      try {
        const tgUrl = await resolveMediaUrl(firstMedia.file_id);
        const fileRes = await fetch(tgUrl);
        if (!fileRes.ok) throw new Error(`Telegram file fetch failed (${fileRes.status})`);
        const buffer = Buffer.from(await fileRes.arrayBuffer());
        const mimeType = firstMedia.type === 'video' ? 'video/mp4' : 'image/jpeg';
        const mediaId = await uploadToWhatsApp(buffer, mimeType);

        await waCloudApi.sendMessage(jid, firstMedia.type === 'video'
          ? { video: { id: mediaId }, caption }
          : { image: { id: mediaId }, caption }
        );
        return true;
      } catch (err) {
        console.error(`media preview send to ${jid} failed:`, err.message);
        return false;
      }
    }

    // ---- To the seller ----
    // 1) Full detail text (all 20 fields), ending with a line pointing at
    //    the photo + gallery link that follow in the next message.
    const sellerIntroLine = firstMedia
      ? `👇 *Your photo preview is below, along with the link to view the full listing.*`
      : mediaLinkLine;

    await waCloudApi.sendMessage(`${phone}@s.whatsapp.net`, {
      text: `✅ *Listing submitted for review!*\n\n${detailLines}\n\n${sellerIntroLine}`
    }).catch(err => console.error('seller notify (detail) failed:', err.message));

    // 2) The actual first photo/video, captioned with the gallery link for
    //    the rest of the media + the review note (skipped if no media).
    if (firstMedia) {
      await sendMediaPreview(`${phone}@s.whatsapp.net`,
        `${mediaLinkLine}\n\n` +
        `Our team will review it shortly. You'll get a message here and the listing page will update once it's approved.\n\n` +
        `Reply *menu* to return.`
      );
    }

    // 3) A tappable Menu button — same pattern as the admin Approve/Reject
    //    buttons below, so it's a real button, not just the typed instruction.
    await waCloudApi.sendMessage(`${phone}@s.whatsapp.net`, {
      buttons: {
        body: 'Tap below to return to the menu anytime.',
        buttons: [{ id: 'menu', title: '📋 Menu' }]
      }
    }).catch(err => console.error('seller notify (menu button) failed:', err.message));

    // ---- To admin: photo/video preview, then full detail as plain text ----
    await sendMediaPreview(adminJid, `📦 *${product.name}* — ${priceStr}`);
    await waCloudApi.sendMessage(adminJid, {
      text: `🆕 *New Listing Pending Review*\n\n${detailLines}\n\n${mediaLinkLine}\n\n👤 *Seller:* ${phone}`
    }).catch(err => console.error('admin notify (detail) failed:', err.message));

    // ...then a short separate Approve/Reject buttons message (interactive
    // message bodies are capped at ~1024 chars by WhatsApp, so it can't
    // carry the full detail block above without risking silent failure).
    await waCloudApi.sendMessage(adminJid, {
      buttons: {
        body: `Approve or reject "${product.name}" (${priceStr}) from ${phone}?`,
        footer: 'Tap to review, or type the command manually.',
        buttons: [
          { id: `approve ${product.id}`, title: '✅ Approve' },
          { id: `reject ${product.id}`, title: '❌ Reject' }
        ]
      }
    }).catch(err => console.error('admin notify (buttons) failed:', err.message));

    res.json({ ok: true, productId: product.id });
    clearSession(`${phone}@s.whatsapp.net`);
  } catch (err) {
    console.error('submit-listing error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function boot() {
  const { error } = await supabase.from('settings').select('id').limit(1);
  if (error) {
    console.error('❌ Supabase connection error:', error.message);
    process.exit(1);
  }
  console.log('✅ Supabase connected');

  if (!process.env.WA_ACCESS_TOKEN || !process.env.WA_PHONE_NUMBER_ID || !process.env.WA_VERIFY_TOKEN || !process.env.WA_APP_SECRET) {
    console.warn('⚠️ One or more WhatsApp Cloud API env vars are missing (WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID, WA_VERIFY_TOKEN, WA_APP_SECRET).');
  }

  await botStatus.setStatus('open'); // Cloud API is a stateless webhook — "connected" as soon as the server is up.

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

  setInterval(async () => {
    await demoteExpiredProPlans();
    await deleteOldSoldProducts();
    await checkExpiringProPlans(sock, `${process.env.ADMIN_WHATSAPP}@s.whatsapp.net`);
  }, 24 * 60 * 60 * 1000);

  setTimeout(async () => { await demoteExpiredProPlans(); }, 10000);
}

boot();

process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error) {
    console.error('Unhandled Rejection:', reason.message);
  } else {
    console.error('Unhandled Rejection (non-Error reason, type:', typeof reason, ')');
  }
});
