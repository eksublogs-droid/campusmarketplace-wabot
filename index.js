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
  askName, handleNameInput, handleEmailInput,
  showMainMenu, handleMainMenuChoice, handleBrowsingChoice,
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

  const { user, isNew } = await userRepo.getOrCreateUser(jid, phone);

  const lower = text.toLowerCase();
  if (lower === 'menu') { clearSession(jid); return showMainMenu(sock, jid, user); }
  if (lower === 'cancel') { clearSession(jid); return showMainMenu(sock, jid, user); }

  // Admin command layer (checked first, admin can still browse/sell like anyone else)
  if (isAdmin(phone)) {
    const handled = await handleAdminCommand(sock, jid, text);
    if (handled) return;
  }

  // ===== registration gate =====
  if (isNew) return askName(sock, jid);
  if (!user.name) return handleNameInput(sock, jid, text, user);
  if (!user.email_submitted) return handleEmailInput(sock, jid, text, user);

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

// Receives submissions from public/sell-form.html (the mobile-friendly
// "one page, all fields" listing form). userId is the WhatsApp phone
// number passed in the form's URL (?userId=<phone>). Photos/videos are
// uploaded separately by the form to Telegram's existing media storage
// before this runs — we only receive their file_id + type here, not the
// actual files. See earlier chat note: media.url vs media.file_id is an
// open question for buyer-side image display and may need revisiting.
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

    const product = await productRepo.createProduct({
      name: b.itemTitle,
      category: b.category,
      condition: b.condition,
      selling_price: sellingPrice,
      description: b.description || '',
      state: b.state,
      city: b.city,
      seller_whatsapp: phone,
      media,
      posted_by: 'user',
      status: 'pending'
    });

    const adminJid = `${process.env.ADMIN_WHATSAPP}@s.whatsapp.net`;
    const notifyText =
      `🆕 *New Listing Pending Review*\n\n` +
      `📦 ${product.name}\n💰 ₦${Number(product.selling_price).toLocaleString()}\n📍 ${product.city}, ${product.state}\n` +
      `👤 Seller: ${phone}`;

    await waCloudApi.sendMessage(`${phone}@s.whatsapp.net`, {
      text: `✅ *Listing submitted for review!*\n\n📦 ${product.name}\n💰 ₦${Number(product.selling_price).toLocaleString()}\n\nOur team will review it shortly.`
    }).catch(() => {});

    await waCloudApi.sendMessage(adminJid, {
      buttons: {
        body: notifyText,
        footer: 'Tap to review, or type the command manually.',
        buttons: [
          { id: `approve ${product.id}`, title: '✅ Approve' },
          { id: `reject ${product.id}`, title: '❌ Reject' }
        ]
      }
    }).catch(() => {});

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
