require('dotenv').config();
const {
  default: makeWASocket,
  DisconnectReason,
  Browsers,
  downloadMediaMessage,
  fetchLatestWaWebVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const pino = require('pino');

const { useSupabaseAuthState } = require('./utils/supabaseAuthState');
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
const { sendDisconnectAlert } = require('./utils/mailer');

const app = express();
app.use(express.json());
app.use(express.static(__dirname + '/public'));

let sock;
let pairingInFlight = false;

const BASE_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 60000;
let consecutiveReconnects = 0;

// FIX (root cause mitigation): the observed pattern is that the bot gets
// killed right when it sends its FIRST automated message after a
// fresh pairing or reconnect — not at a random point. WhatsApp's
// companion-session validation appears to scrutinize a device most
// heavily in the moments right after it (re)connects. This settle window
// holds off ANY automated outbound send for a short period after
// connecting, so the socket looks "settled" before it starts acting.
// This does not guarantee anything (that decision happens on WhatsApp's
// servers, outside this code's control) — it only removes the one
// concrete signal we can control: instant automated activity immediately
// after (re)connecting.
const SETTLE_MS_FRESH_LOGIN = 90 * 1000; // just paired via a brand new code
const SETTLE_MS_RECONNECT = 8 * 1000;    // routine reconnect with existing creds
let settleUntil = 0;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jitteredBackoff() {
  const exp = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * Math.pow(1.6, consecutiveReconnects));
  const jitter = exp * (0.8 + Math.random() * 0.4); // +/-20%
  return Math.round(jitter);
}

async function connectToWhatsApp() {
  const { state, saveCreds, waitForPendingSave, clearAll } = await useSupabaseAuthState();

  // Baileys' own docs say to use the bundled default version instead of
  // fetching latest — normally correct. But the bundled default is
  // currently stale (WhiskeySockets/Baileys#1929), so WhatsApp's servers
  // reject the handshake with it right now. Fetching the live version
  // fixes that; if the fetch itself fails, fall back to the bundled
  // default rather than crashing the boot.
  let version;
  try {
    ({ version } = await fetchLatestWaWebVersion());
  } catch (err) {
    console.error('Could not fetch latest WA web version, using bundled default:', err.message);
  }

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    version,
    // Pairing-code login specifically requires a real, recognized
    // platform triplet here — a custom/branded name (e.g. our old
    // ['CampusMarketplace', 'Chrome', '1.0.0']) causes WhatsApp to
    // silently reject the link even though the code itself generates
    // fine. This is documented directly by Baileys' maintainers as the
    // one gotcha specific to pairing-code login.
    browser: Browsers.ubuntu('Chrome'),
    // FIX: leaving this at Baileys' default (true) marks the companion as
    // always-online and can suppress push notifications to the phone
    // itself, which is both a poor look to the account owner and an
    // extra "this is a bot" signal. false is the more human-like default.
    markOnlineOnConnect: false
  });

  // FIX: previously only the very first welcome message to a brand-new
  // contact got a "typing" pause (via humanize.js) — every other reply
  // (menus, browsing, order updates) was sent instantly with zero delay.
  // A conversation where 95% of replies are delivered with no typing time
  // at all, and only the very first one has a pause, is itself a pattern.
  // This wraps sendMessage once, globally, so every reply to a real
  // 1:1 chat gets a short, randomized typing pause + presence update, and
  // sends to different contacts are spaced out slightly so a burst of new
  // messages doesn't fire off several automated replies in the same
  // instant. Kept short (well under a couple seconds) so normal
  // menu-driven use doesn't feel sluggish.
  const rawSendMessage = sock.sendMessage.bind(sock);
  const GLOBAL_MIN_DELAY_MS = 500;
  const GLOBAL_MAX_DELAY_MS = 1300;
  const GLOBAL_MIN_GAP_MS = 700;
  let lastGlobalSendAt = 0;
  sock.sendMessage = async (jid, content, options) => {
    const isDirectChat = typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
    if (!isDirectChat) return rawSendMessage(jid, content, options);

    const now = Date.now();
    const earliestSlot = Math.max(now, lastGlobalSendAt + GLOBAL_MIN_GAP_MS);
    lastGlobalSendAt = earliestSlot;
    const gapMs = earliestSlot - now;
    const thinkMs = Math.floor(Math.random() * (GLOBAL_MAX_DELAY_MS - GLOBAL_MIN_DELAY_MS + 1)) + GLOBAL_MIN_DELAY_MS;

    try { await sock.sendPresenceUpdate('composing', jid); } catch (_) {}
    await delay(gapMs + thinkMs);
    try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {}
    return rawSendMessage(jid, content, options);
  };

  // Pairing code is now requested from the web dashboard (POST /api/link)
  // instead of automatically at boot — no terminal needed. If not yet
  // registered, we just wait for the dashboard to trigger requestPairingCode.
  if (!sock.authState.creds.registered) {
    await botStatus.setStatus('close');
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, isNewLogin } = update;
    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`Connection closed. statusCode: ${statusCode}. Reconnecting: ${shouldReconnect}`);
      await botStatus.setStatus('close');
      if (shouldReconnect) {
        // Make sure any in-flight creds write (e.g. from a just-issued
        // pairing code) has actually landed in Supabase before we spin up
        // a new socket that reloads creds from there. Without this, a fast
        // reconnect can load stale keys and silently invalidate the code
        // the user is about to type in.
        await waitForPendingSave();
        // FIX: was a fixed 3s delay. If the connection is being killed
        // repeatedly in a tight loop, hammering WhatsApp's servers on a
        // fixed cadence looks more automated, not less. This backs off
        // exponentially (with jitter) the more times in a row it happens,
        // and resets once a connection has actually stayed open a while.
        const backoffMs = jitteredBackoff();
        consecutiveReconnects += 1;
        console.log(`Reconnecting in ~${Math.round(backoffMs / 1000)}s (attempt ${consecutiveReconnects}).`);
        await delay(backoffMs);
        connectToWhatsApp();
      } else {
        // A real logged-out (401) means the stored credentials are
        // permanently invalid — WhatsApp will keep rejecting them forever.
        // Previously this left `sock` dead with no way to recover except a
        // manual redeploy. Instead, wipe the stale auth state and boot a
        // fresh, unregistered session so a new pairing code can be issued.
        console.log('Logged out — clearing stale auth state and starting fresh session.');
        const { phone: lastKnownPhone } = await botStatus.getStatus();
        sendDisconnectAlert(lastKnownPhone);
        await clearAll();
        await delay(BASE_RECONNECT_DELAY_MS);
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp connected!');
      const phone = sock.user && sock.user.id ? sock.user.id.split(':')[0].split('@')[0] : null;
      await botStatus.setStatus('open', phone);

      // Reset the reconnect backoff once a connection has actually opened —
      // otherwise a bot that's been stable for hours would still be
      // carrying yesterday's backoff count.
      consecutiveReconnects = 0;

      // FIX: start the settle window (see comment at top of file). A fresh
      // pairing gets a longer window than a routine reconnect with
      // existing creds, since a brand-new device link is the higher-risk
      // moment.
      const settleMs = isNewLogin ? SETTLE_MS_FRESH_LOGIN : SETTLE_MS_RECONNECT;
      settleUntil = Date.now() + settleMs;
      console.log(`Settle window active for ${Math.round(settleMs / 1000)}s before automated replies begin (isNewLogin: ${!!isNewLogin}).`);

      // FIX: explicitly initialize presence once, right after the socket
      // opens, before any composing/paused updates are sent later. Some
      // Baileys reports show composing/paused presence behaving
      // unreliably if an initial 'available' presence was never sent —
      // this makes sure the presence subsystem is in a known state first.
      try {
        await sock.sendPresenceUpdate('available');
      } catch (_) {
        // Non-fatal — presence issues shouldn't block the socket itself.
      }
    } else if (connection === 'connecting') {
      await botStatus.setStatus('connecting');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    try {
      await handleIncomingMessage(msg);
    } catch (err) {
      console.error('Message handling error:', err);
    }
  });

  return sock;
}

function extractText(msg) {
  const m = msg.message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.templateButtonReplyMessage?.selectedId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  );
}

async function downloadMedia(msg) {
  return downloadMediaMessage(msg, 'buffer', {});
}

function mimeTypeOf(msg) {
  const m = msg.message;
  return m.imageMessage?.mimetype || m.videoMessage?.mimetype || 'image/jpeg';
}

async function handleIncomingMessage(msg) {
  // FIX: if we're still inside the post-(re)connect settle window, defer
  // processing this message until it elapses instead of replying
  // instantly. This targets the exact moment identified as the trigger —
  // an automated reply firing immediately after connecting — without
  // dropping the message; it just gets handled a little later.
  const remaining = settleUntil - Date.now();
  if (remaining > 0) {
    console.log(`Deferring message handling ${Math.round(remaining / 1000)}s (settle window active).`);
    setTimeout(() => {
      handleIncomingMessage(msg).catch((err) => console.error('Deferred message handling error:', err));
    }, remaining + 250);
    return;
  }

  const jid = msg.key.remoteJid;
  if (jid.endsWith('@g.us')) return; // ignore groups
  const phone = jid.replace('@s.whatsapp.net', '');
  const text = extractText(msg).trim();

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
  const msgType = Object.keys(msg.message)[0];
  if (msgType === 'imageMessage' || msgType === 'videoMessage') {
    if (session && session.step === 'sell_media') {
      const buffer = await downloadMedia(msg);
      await handleSellMedia(sock, jid, buffer, mimeTypeOf(msg));
      return;
    }
    if (session && session.step === 'upgrade_awaiting_receipt') {
      const buffer = await downloadMedia(msg);
      await handleUpgradeReceiptMedia(sock, jid, buffer, mimeTypeOf(msg), user);
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

app.post('/api/link', async (req, res) => {
  const phone = (req.body.phone || '').replace(/\D/g, '');
  if (!phone || phone.length < 10) {
    return res.status(400).json({ error: 'Enter a valid phone number with country code.' });
  }
  if (!sock) return res.status(503).json({ error: 'Bot is still starting up, try again in a few seconds.' });

  if (sock.authState.creds.registered) {
    return res.json({ alreadyLinked: true });
  }
  if (pairingInFlight) {
    return res.status(429).json({ error: 'A pairing request is already in progress, please wait.' });
  }

  pairingInFlight = true;
  try {
    const code = await sock.requestPairingCode(phone);
    await botStatus.setStatus('connecting', phone);
    res.json({ code });
  } catch (err) {
    console.error('Pairing code error:', err.message);
    res.status(500).json({ error: 'Could not generate a pairing code. Make sure the number is correct and try again.' });
  } finally {
    pairingInFlight = false;
  }
});

const supabase = require('./utils/supabaseClient');

async function boot() {
  // Simple connectivity check instead of mongoose.connect — Supabase client
  // doesn't need an explicit "connect" step, just verify credentials work.
  const { error } = await supabase.from('settings').select('id').limit(1);
  if (error) {
    console.error('❌ Supabase connection error:', error.message);
    process.exit(1);
  }
  console.log('✅ Supabase connected');

  await botStatus.loadPersistedStatus();
  await connectToWhatsApp();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

  setInterval(async () => {
    await demoteExpiredProPlans();
    await deleteOldSoldProducts();
    if (sock) await checkExpiringProPlans(sock, `${process.env.ADMIN_WHATSAPP}@s.whatsapp.net`);
  }, 24 * 60 * 60 * 1000);

  setTimeout(async () => { await demoteExpiredProPlans(); }, 10000);
}

boot();

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
