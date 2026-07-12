const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const supabase = require('./supabaseClient');

// Drop-in replacement for useMultiFileAuthState() that persists to Supabase
// (Postgres) instead of the local filesystem. Needed because Railway wipes
// disk on every redeploy — without this you'd have to re-pair WhatsApp
// every single time you push code.
async function useSupabaseAuthState() {
  const writeData = async (key, data) => {
    const json = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
    await supabase.from('auth_state').upsert({ key, value: json });
  };

  const readData = async (key) => {
    const { data } = await supabase.from('auth_state').select('value').eq('key', key).maybeSingle();
    if (!data) return null;
    return JSON.parse(JSON.stringify(data.value), BufferJSON.reviver);
  };

  const removeData = async (key) => {
    await supabase.from('auth_state').delete().eq('key', key);
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData('creds', creds)
  };
}

module.exports = { useSupabaseAuthState };
