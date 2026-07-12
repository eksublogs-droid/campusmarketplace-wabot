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

  const clearAll = async () => {
    await supabase.from('auth_state').delete().neq('key', '');
  };

  const creds = (await readData('creds')) || initAuthCreds();

  // Baileys fires the 'creds.update' event (which calls saveCreds) but does
  // NOT wait for it to finish before it may close/reconnect the socket â€”
  // e.g. right after requestPairingCode(), which triggers a near-immediate
  // restart. If a reconnect reloads creds from Supabase before this write
  // lands, it gets stale keys and the pairing code becomes invalid even
  // though the user typed it in fast enough. We track the in-flight save so
  // the reconnect logic can explicitly wait for it first.
  let pendingSave = Promise.resolve();

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
    saveCreds: () => {
      pendingSave = writeData('creds', creds);
      return pendingSave;
    },
    // Call this before reconnecting to guarantee the latest creds (e.g. the
    // ones tied to a just-issued pairing code) are actually persisted first.
    waitForPendingSave: () => pendingSave,
    // Wipes all persisted auth data. Used to self-heal after WhatsApp
    // reports a real logged-out/invalid session, so the next boot starts
    // completely clean instead of retrying forever with dead credentials.
    clearAll
  };
}

module.exports = { useSupabaseAuthState };
