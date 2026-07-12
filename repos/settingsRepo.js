const supabase = require('../utils/supabaseClient');

async function getSettings() {
  const { data } = await supabase.from('settings').select('*').limit(1).maybeSingle();
  if (data) return data;
  const { data: created } = await supabase
    .from('settings')
    .insert({ pro_price_per_day: 1000, bank_accounts: [] })
    .select()
    .single();
  return created;
}

async function addBankAccount(bankName, accountNumber, accountName) {
  const settings = await getSettings();
  const banks = settings.bank_accounts || [];
  banks.push({ bankName, accountNumber, accountName, active: true });
  const { data, error } = await supabase
    .from('settings')
    .update({ bank_accounts: banks, updated_at: new Date().toISOString() })
    .eq('id', settings.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function removeBankAccount(index) {
  const settings = await getSettings();
  const banks = settings.bank_accounts || [];
  if (index < 0 || index >= banks.length) throw new Error('Invalid bank index');
  banks.splice(index, 1);
  const { data, error } = await supabase
    .from('settings')
    .update({ bank_accounts: banks, updated_at: new Date().toISOString() })
    .eq('id', settings.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function setProPrice(pricePerDay) {
  const settings = await getSettings();
  const { data, error } = await supabase
    .from('settings')
    .update({ pro_price_per_day: pricePerDay, updated_at: new Date().toISOString() })
    .eq('id', settings.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

module.exports = { getSettings, addBankAccount, removeBankAccount, setProPrice };
