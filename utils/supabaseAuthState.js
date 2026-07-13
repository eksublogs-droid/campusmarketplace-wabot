const { initAuthCreds, BufferJSON, proto, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const supabase = require('./supabaseClient');

// Silent logger purely for the cache wrapper's internal trace logs — same
// convention as the "silent" logger already used for the socket itself.
const cacheLogger = pino({ level: 'silent' });

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

  // FIX: Baileys emits `isNewLogin: true` as a one-off event the instant a
  // pairing code is entered, on the socket that WhatsApp is about to force
  // to restart (mandatory post-pair reconnect). That restart always builds
  // a brand new socket, so nothing in memory survives to tell the NEXT
  // socket "we just paired" when it opens. Persisting it here — in the
  // same auth_state table everything else already uses, no schema change —
  // is what lets that next socket still know. clearAll() above already
  // wipes this key with everything else on a real logout, so it
  // self-resets correctly with no extra handling needed.
  const PAIRING_KEY = 'recent_pairing_at';

  const markRecentPairing = async () => {
    await writeData(PAIRING_KEY, { at: Date.now() });
  };

  const getRecentPairingAt = async () => {
    const value = await readData(PAIRING_KEY);
    return value && typeof value.at === 'number' ? value.at : null;
  };

  const creds = (await readData('creds')) || initAuthCreds();

  // Baileys fires the 'creds.update' event (which calls saveCreds) but does
  // NOT wait for it to finish before it may close/reconnect the socket —
  // e.g. right after requestPairingCode(), which triggers a near-immediate
  // restart. If a reconnect reloads creds from Supabase before this write
  // lands, it gets stale keys and the pairing code becomes invalid even
  // though the user typed it in fast enough. We track the in-flight save so
  // the reconnect logic can explicitly wait for it first.
  let pendingSave = Promise.resolve();

  // Raw Supabase-backed key store — every get/set here is a real network
  // round-trip to Postgres. This is the same shape Baileys' own
  // useMultiFileAuthState uses internally (get(type, ids) / set(data)), so
  // it's directly compatible with the caching wrapper below.
  const rawKeyStore = {
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
  };

  return {
    state: {
      creds,
      // FIX: wrap the raw Supabase-backed store with Baileys' own
      // recommended caching layer (makeCacheableSignalKeyStore). Every
      // Signal-protocol operation — encrypting/decrypting a message,
      // establishing a session with a new contact, etc. — reads and
      // writes these keys, often several times per message. Without this
      // wrapper, every one of those reads is a live network round-trip to
      // Supabase, every single time, for every message. Baileys'
      // migration guide and README explicitly call this out as required
      // for any custom (non-file) auth state implementation. This adds
      // an in-memory cache in front of the same raw store above — no
      // change to what gets persisted or how, purely removes redundant
      // network round-trips on the exact operation (real message
      // send/receive) that has been triggering the disconnects.
      keys: makeCacheableSignalKeyStore(rawKeyStore, cacheLogger)
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
    clearAll,
    // Call when the standalone `isNewLogin: true` event fires, to persist
    // the moment of pairing outside the socket.
    markRecentPairing,
    // Returns the ms-epoch timestamp of the most recent pairing, or null
    // if none is on record (or it was cleared by clearAll()).
    getRecentPairingAt
  };
}

module.exports = { useSupabaseAuthState };
