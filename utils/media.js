const supabase = require('./supabaseClient');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHANNEL = process.env.TELEGRAM_CHANNEL_ID;

// ---- Product photos/videos now live in a private Telegram channel ----
// Telegram storage is free and effectively unlimited, unlike Supabase's
// 1GB free-tier file storage cap. Uploading returns a file_id (not a URL).
// A file_id never expires, but it can't be shown to a WhatsApp buyer
// directly — resolveMediaUrl() below turns it into a real, short-lived
// (~1 hour) download link, which must be requested fresh right before
// each time we actually need to display the image. Never store that link.
async function uploadToTelegram(buffer, mimeType) {
  if (!TG_TOKEN || !TG_CHANNEL) {
    throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID not set on the server');
  }

  const isVideo = mimeType && mimeType.includes('video');
  const method = isVideo ? 'sendVideo' : 'sendPhoto';
  const field = isVideo ? 'video' : 'photo';

  const form = new FormData();
  form.append('chat_id', TG_CHANNEL);
  form.append(field, new Blob([buffer], { type: mimeType || 'image/jpeg' }), isVideo ? 'video.mp4' : 'photo.jpg');

  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    body: form
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'Telegram upload failed');

  return isVideo
    ? data.result.video.file_id
    : data.result.photo[data.result.photo.length - 1].file_id; // last = highest resolution
}

// Turns a stored file_id back into a real, downloadable HTTPS link, valid
// for about 1 hour. Call this right before sending the image to a buyer —
// never cache/store the result, since it will go stale.
async function resolveMediaUrl(fileId) {
  if (!TG_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not set on the server');
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const data = await res.json();
  if (!data.ok || !data.result.file_path) throw new Error(data.description || 'Could not resolve Telegram file');
  return `https://api.telegram.org/file/bot${TG_TOKEN}/${data.result.file_path}`;
}

// Uploads a raw buffer (downloaded from a WhatsApp message, or received
// from the sell form) to storage.
// - bucket === 'product-media': goes to the Telegram channel — returns a
//   file_id (see uploadToTelegram above).
// - anything else (e.g. 'payment-receipts'): stays on Supabase Storage as
//   before — returns a public URL. Receipts are low-volume/admin-only, so
//   there's no need to move them off Supabase.
async function uploadBuffer(buffer, mimeType, bucket = 'product-media') {
  if (bucket === 'product-media') {
    return uploadToTelegram(buffer, mimeType);
  }

  const ext = mimeType && mimeType.includes('video') ? 'mp4' : 'jpg';
  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, buffer, { contentType: mimeType || 'image/jpeg', upsert: false });

  if (error) throw error;

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

// Uploads a buffer directly to WhatsApp's own Media API
// (POST /{phone_number_id}/media) and returns the resulting media `id`.
// Sending a message with { id } instead of { link } means Meta never has
// to fetch the file from a third party (Telegram) in the background —
// that background fetch was failing silently (WhatsApp accepts the send
// immediately, then reports the real failure later via a `statuses`
// webhook, which nothing was reading). Uploading the bytes ourselves
// removes that failure point entirely.
async function uploadToWhatsApp(buffer, mimeType) {
  const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
  const ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    throw new Error('WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN not set on the server');
  }

  const isVideo = mimeType && mimeType.includes('video');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType || 'image/jpeg' }), isVideo ? 'video.mp4' : 'photo.jpg');

  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: form
  });
  const data = await res.json();
  if (!data.id) throw new Error(data?.error?.message || 'WhatsApp media upload failed');
  return data.id;
}

// Deletes stored files. Only applies to Supabase-backed buckets (e.g.
// payment-receipts) — product photos live in the free/unlimited Telegram
// channel now, so there's nothing to clean up there; safe no-op.
async function deleteFiles(items, bucket = 'product-media') {
  if (bucket === 'product-media') return;
  if (!items || items.length === 0) return;
  const paths = items
    .map(u => (typeof u === 'string' ? u : u && u.url))
    .filter(Boolean)
    .map(u => {
      const marker = `/public/${bucket}/`;
      const idx = u.indexOf(marker);
      return idx === -1 ? null : u.slice(idx + marker.length);
    })
    .filter(Boolean);

  if (paths.length === 0) return;
  const { error } = await supabase.storage.from(bucket).remove(paths);
  if (error) console.error('deleteFiles error:', error.message);
}

module.exports = { uploadBuffer, deleteFiles, resolveMediaUrl, uploadToWhatsApp };
