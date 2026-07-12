const supabase = require('../utils/supabaseClient');

async function createReceipt(fields) {
  const { data, error } = await supabase.from('payment_receipts').insert(fields).select().single();
  if (error) throw error;
  return data;
}

async function getReceiptById(id) {
  const { data } = await supabase.from('payment_receipts').select('*').eq('id', id).maybeSingle();
  return data;
}

async function getPendingReceipts() {
  const { data } = await supabase
    .from('payment_receipts')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(20);
  return data || [];
}

async function updateReceipt(id, fields) {
  const { data, error } = await supabase.from('payment_receipts').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

module.exports = { createReceipt, getReceiptById, getPendingReceipts, updateReceipt };
