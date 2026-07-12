// Sends a one-off alert email when WhatsApp logs the bot out, so you find
// out from your inbox instead of noticing the dashboard went quiet.
// Fire-and-forget by design: a mail hiccup (bad creds, Gmail hiccup, no
// network) must never throw into the reconnect logic in index.js.

const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.ALERT_EMAIL_USER || !process.env.ALERT_EMAIL_APP_PASSWORD) return null;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.ALERT_EMAIL_USER,
      pass: process.env.ALERT_EMAIL_APP_PASSWORD
    }
  });
  return transporter;
}

async function sendDisconnectAlert(phone) {
  const t = getTransporter();
  if (!t || !process.env.ALERT_EMAIL_TO) {
    console.error('Mailer not configured (missing ALERT_EMAIL_* vars) — skipping disconnect email.');
    return;
  }
  try {
    await t.sendMail({
      from: `"CampusMarketplace Bot" <${process.env.ALERT_EMAIL_USER}>`,
      to: process.env.ALERT_EMAIL_TO,
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
