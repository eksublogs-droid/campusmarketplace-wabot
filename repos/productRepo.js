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

// ===== Buy Items page (public browse/filter) =====
//
// Only the columns a buyer is allowed to see are ever selected here —
// seller_whatsapp and the seller's email are never part of this query, so
// they never leave Supabase for the browse grid. (The detail lookup below
// is different — see getProductByRef.)
const BROWSE_FIELDS = [
  'id', 'ref_code', 'name', 'media', 'category', 'subcategory', 'brand',
  'condition', 'selling_price', 'negotiable', 'lowest_price', 'state',
  'city', 'item_location', 'is_premium', 'created_at'
].join(', ');

// filters: { category, subcategory, state, proximity, negotiable, sort,
//            page, limit, minPrice, maxPrice, condition, brand }
// proximity: 'hostel' | 'around' | 'town' | undefined/'any' (skip)
// negotiable: 'yes' | 'no' | undefined/'any' (skip)
// sort: 'newest' (default) | 'price_low' | 'price_high'
async function getFilteredProducts(filters = {}) {
  const {
    category, subcategory, state, proximity, negotiable, sort,
    minPrice, maxPrice, condition, brand
  } = filters;
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(filters.limit, 10) || 20), 50);

  let q = supabase
    .from('products')
    .select(BROWSE_FIELDS, { count: 'exact' })
    .eq('status', 'active');

  if (category) q = q.eq('category', category);
  if (subcategory) q = q.eq('subcategory', subcategory);
  if (state) q = q.eq('state', state);
  if (proximity && proximity !== 'any') q = q.eq('item_location', proximity);
  if (negotiable === 'yes') q = q.eq('negotiable', true);
  if (negotiable === 'no') q = q.eq('negotiable', false);
  if (condition) q = q.eq('condition', condition);
  if (brand) q = q.ilike('brand', `%${brand}%`);
  if (minPrice !== undefined && minPrice !== null && !isNaN(minPrice)) q = q.gte('selling_price', minPrice);
  if (maxPrice !== undefined && maxPrice !== null && !isNaN(maxPrice)) q = q.lte('selling_price', maxPrice);

  // Pro/premium listings always pinned to the top, exactly like the
  // existing getActiveProducts ordering — regardless of chosen sort.
  q = q.order('is_premium', { ascending: false });
  if (sort === 'price_low') q = q.order('selling_price', { ascending: true });
  else if (sort === 'price_high') q = q.order('selling_price', { ascending: false });
  else q = q.order('created_at', { ascending: false }); // 'newest' default

  const offset = (page - 1) * limit;
  q = q.range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) throw error;
  return { data: data || [], total: count || 0, page, limit };
}

// Full row, INCLUDING seller_whatsapp — used only in two places that never
// forward it to a browser: (1) the /api/products/ref/:ref route, which
// explicitly builds its own allowlisted JSON response and never touches
// this field, and (2) the WhatsApp admin "Search Product" flow, which
// sends it back to the admin's own WhatsApp chat, not over HTTP.
async function getProductByRef(refCode) {
  if (!refCode) return null;
  const { data } = await supabase
    .from('products')
    .select('*')
    .eq('ref_code', String(refCode).trim().toUpperCase())
    .maybeSingle();
  return data;
}

module.exports = {
  createProduct, getActiveProducts, getProductById, updateProduct,
  getProductsBySellerPhone, getPendingProducts, getActiveProductsAll,
  demoteExpiredPro, deleteOldSold, getSoonExpiringPro,
  getFilteredProducts, getProductByRef
};
