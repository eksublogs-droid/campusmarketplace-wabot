const supabase = require('./supabaseClient');

// Uploads a raw buffer (downloaded from a WhatsApp message) to a Supabase
// Storage bucket and returns its public URL.
async function uploadBuffer(buffer, mimeType, bucket = 'product-media') {
  const ext = mimeType && mimeType.includes('video') ? 'mp4' : 'jpg';
  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, buffer, { contentType: mimeType || 'image/jpeg', upsert: false });

  if (error) throw error;

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

module.exports = { uploadBuffer };
