const supabase = require('../utils/supabaseClient');

async function getOrCreateUser(whatsappId, phone) {
  let { data: user } = await supabase.from('users').select('*').eq('whatsapp_id', whatsappId).maybeSingle();
  let isNew = false;

  if (!user) {
    const { data: created, error } = await supabase
      .from('users')
      .insert({ whatsapp_id: whatsappId, phone })
      .select()
      .single();
    if (error) throw error;
    user = created;
    isNew = true;
  }

  await supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('id', user.id);
  return { user, isNew };
}

async function updateUser(id, fields) {
  const { data, error } = await supabase.from('users').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

async function getUserByPhone(phone) {
  const { data } = await supabase.from('users').select('*').eq('phone', phone).maybeSingle();
  return data;
}

async function listUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .order('registered_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function deleteUserByPhone(phone) {
  const { error } = await supabase.from('users').delete().eq('phone', phone);
  if (error) throw error;
}

module.exports = { getOrCreateUser, updateUser, getUserByPhone, listUsers, deleteUserByPhone };
