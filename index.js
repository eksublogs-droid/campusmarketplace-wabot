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

const app = express();
app.use(express.json());
app.use(express.static(__dirname + '/public'));

let sock;
let pairingInFlight = false;

const RECONNECT_DELAY_MS = 3000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    // one gotcha specific to pairing-code login. Once truly paired, this
    // could be swapped back to a custom name if desired.
    browser: Browsers.ubuntu('Chrome')
  });

  // Pairing code is now requested from the web dashboard (POST /api/link)
  // instead of automatically at boot — no terminal needed. If not yet
  // registered, we just wait for the dashboard to trigger requestPairingCode.
  if (!sock.authState.creds.registered) {
    await botStatus.setStatus('close');
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
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
        // Brief backoff so a persistent failure reconnects on a steady
        // cadence instead of hammering WhatsApp's servers in a tight loop
        // (which risks its own 429 rate-limit failure mode).
        await delay(RECONNECT_DELAY_MS);
        connectToWhatsApp();
      } else {
        // A real logged-out (401) means the stored credentials are
        // permanently invalid — WhatsApp will keep rejecting them forever.
        // Previously this left `sock` dead with no way to recover except a
        // manual redeploy. Instead, wipe the stale auth state and boot a
        // fresh, unregistered session so a new pairing code can be issued.
        console.log('Logged out — clearing stale auth state and starting fresh session.');
        await clearAll();
        await delay(RECONNECT_DELAY_MS);
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp connected!');
      const phone = sock.user && sock.user.id ? sock.user.id.split(':')[0].split('@')[0] : null;
      await botStatus.setStatus('open', phone);
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
