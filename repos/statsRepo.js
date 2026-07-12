const supabase = require('../utils/supabaseClient');

async function getStats() {
  const [pending, active, receipts, users] = await Promise.all([
    supabase.from('products').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('products').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('payment_receipts').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('users').select('id', { count: 'exact', head: true })
  ]);

  return {
    pendingListings: pending.count || 0,
    activeListings: active.count || 0,
    pendingReceipts: receipts.count || 0,
    totalUsers: users.count || 0
  };
}

module.exports = { getStats };
