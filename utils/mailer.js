// Sends a one-off alert email when WhatsApp logs the bot out, so you find
// out from your inbox instead of noticing the dashboard went quiet.
//
// Deliberately dependency-free: talks raw SMTP over TLS to Gmail using
// Node's built-in `tls` module instead of nodemailer. Railway's build uses
// `npm ci`, which fails hard the moment package.json and package-lock.json
// disagree — and generating a correct lock file entry (with real npm
// registry integrity hashes) isn't something that can be done offline. Zero
// new packages means zero chance of that happening again over this.
//
// Fire-and-forget by design: a mail hiccup (bad creds, Gmail hiccup, no
// network) must never throw into the reconnect logic in index.js.

const tls = require('tls');

const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 465; // implicit TLS — no STARTTLS upgrade needed
const SOCKET_TIMEOUT_MS = 15000;

const b64 = (str) => Buffer.from(str, 'utf8').toString('base64');

// Resolves once a full SMTP reply has arrived. A reply is "complete" when
// its last line matches "NNN " (space, not dash) — multi-line replies use
// "NNN-" for every line except the final one.
function readReply(socket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3} /.test(last)) {
        cleanup();
        resolve(buf.trim());
      }
    };
    const onError = (err) => { cleanup(); reject(err); };
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function cmd(socket, line) {
  socket.write(line + '\r\n');
  const reply = await readReply(socket);
  const code = parseInt(reply.slice(0, 3), 10);
  if (code >= 400) throw new Error(`SMTP error on "${line.split(' ')[0]}": ${reply}`);
  return reply;
}

// Per RFC 5321: any body line that starts with "." must have that dot
// doubled, so the server doesn't mistake it for the end-of-message marker.
function dotStuff(text) {
  return text.split('\n').map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
}

async function sendGmail({ user, pass, to, fromName, subject, text }) {
  const socket = tls.connect({ host: SMTP_HOST, port: SMTP_PORT });
  socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy(new Error('SMTP connection timed out')));

  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('error', reject);
  });

  try {
    await readReply(socket); // server greeting, "220 ..."
    await cmd(socket, 'EHLO campusmarketplacebot.local');
    await cmd(socket, 'AUTH LOGIN');
    await cmd(socket, b64(user));
    await cmd(socket, b64(pass));
    await cmd(socket, `MAIL FROM:<${user}>`);
    await cmd(socket, `RCPT TO:<${to}>`);
    await cmd(socket, 'DATA');

    const message =
      `From: "${fromName}" <${user}>\r\n` +
      `To: ${to}\r\n` +
      `Subject: ${subject}\r\n` +
      `Content-Type: text/plain; charset=UTF-8\r\n` +
      `\r\n` +
      dotStuff(text);

    await cmd(socket, `${message}\r\n.`);
    await cmd(socket, 'QUIT');
  } finally {
    socket.end();
  }
}

async function sendDisconnectAlert(phone) {
  const user = process.env.ALERT_EMAIL_USER;
  const pass = process.env.ALERT_EMAIL_APP_PASSWORD;
  const to = process.env.ALERT_EMAIL_TO;

  if (!user || !pass || !to) {
    console.error('Mailer not configured (missing ALERT_EMAIL_* vars) — skipping disconnect email.');
    return;
  }

  try {
    await sendGmail({
      user,
      pass,
      to,
      fromName: 'CampusMarketplace Bot',
      subject: '⚠️ CampusMarketplace WhatsApp bot got logged out',
      text:
        `The WhatsApp bot${phone ? ` (${phone})` : ''} was logged out by WhatsApp at ${new Date().toISOString()}.\n\n` +
        `It has cleared its old session automatically and is now waiting for a fresh pairing code from the dashboard.\n\n` +
        `Check now: https://campusmarketplace-wabot-production.up.railway.app/\n\n` +
        `Open that link and re-link the number when you get a chance.`
    });
    console.log('📧 Disconnect alert email sent.');
  } catch (err) {
    console.error('Failed to send disconnect alert email:', err.message);
  }
}

module.exports = { sendDisconnectAlert };
