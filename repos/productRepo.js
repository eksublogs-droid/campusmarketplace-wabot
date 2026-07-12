const supabase = require('../utils/supabaseClient');

async function createProduct(fields) {
  const { data, error } = await supabase.from('products').insert(fields).select().single();
  if (error) throw error;
  return data;
}

async function getActiveProducts(offset, limit) {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('status', 'active')
    .order('is_premium', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
}

async function getProductById(id) {
  const { data } = await supabase.from('products').select('*').eq('id', id).maybeSingle();
  return data;
}

async function updateProduct(id, fields) {
  const { data, error } = await supabase.from('products').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

async function getProductsBySellerPhone(phone) {
  const { data } = await supabase
    .from('products')
    .select('*')
    .eq('seller_whatsapp', phone)
    .order('created_at', { ascending: false })
    .limit(10);
  return data || [];
}

async function getPendingProducts() {
  const { data } = await supabase.from('products').select('*').eq('status', 'pending').order('created_at', { ascending: true }).limit(20);
  return data || [];
}

async function getActiveProductsAll() {
  const { data } = await supabase.from('products').select('*').eq('status', 'active').order('created_at', { ascending: false }).limit(20);
  return data || [];
}

async function demoteExpiredPro() {
  await supabase
    .from('products')
    .update({ is_premium: false, premium_expires_at: null })
    .eq('is_premium', true)
    .lte('premium_expires_at', new Date().toISOString());
}

async function deleteOldSold() {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from('products').delete().eq('status', 'sold').lte('sold_at', cutoff);
}

async function getSoonExpiringPro() {
  const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const { data } = await supabase
    .from('products')
    .select('*')
    .eq('is_premium', true)
    .lte('premium_expires_at', in24h)
    .gt('premium_expires_at', now);
  return data || [];
}

module.exports = {
  createProduct, getActiveProducts, getProductById, updateProduct,
  getProductsBySellerPhone, getPendingProducts, getActiveProductsAll,
  demoteExpiredPro, deleteOldSold, getSoonExpiringPro
};
