require('dotenv').config();
const crypto = require('crypto');
const express = require('express');

const waCloudApi = require('./utils/waCloudApi');
const { getSession, setSession, clearSession } = require('./utils/session');
const { parseMenuChoice } = require('./utils/menu');
const botStatus = require('./utils/botStatus');

const userRepo = require('./repos/userRepo');
const statsRepo = require('./repos/statsRepo');

const {
  askName, handleNameInput, handleEmailInput,
  showMainMenu, handleMainMenuChoice, handleBrowsingChoice,
  handleViewingProductChoice, MAIN_OPTIONS
} = require('./handlers/user');
const { handleSellTextStep, handleSellMedia } = require('./handlers/sell');
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

// Protected by ADMIN_PANEL_KEY env var, sent as an 'x-admin-key' header —
// keeps the password out of the URL/browser history, unlike a query param.
function checkAdminKey(req, res) {
  const expected = process.env.ADMIN_PANEL_KEY;
  if (!expected) {
    res.status(500).json({ error: 'ADMIN_PANEL_KEY not set on the server' });
    return false;
  }
  if (req.headers['x-admin-key'] !== expected) {
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

const supabase = require('./utils/supabaseClient');

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
