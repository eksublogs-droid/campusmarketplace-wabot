// Reusable core for syncing a Flow JSON string to Meta as a published
// WhatsApp Flow. Both the CLI (sync-flow.js) and the HTTP admin route
// call into this — no duplicated logic between them.

const GRAPH_VERSION = 'v20.0';

async function graph(token, pathSuffix, options = {}) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pathSuffix}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Graph API error (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function findFlowByName(token, wabaId, name) {
  const data = await graph(token, `${wabaId}/flows?fields=id,name,status`);
  return (data.data || []).find(f => f.name === name);
}

async function createFlow(token, wabaId, name) {
  const data = await graph(token, `${wabaId}/flows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, categories: ['OTHER'] })
  });
  return data.id;
}

async function uploadFlowJson(token, flowId, flowJson) {
  const form = new FormData();
  form.append('file', new Blob([flowJson], { type: 'application/json' }), 'flow.json');
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  return graph(token, `${flowId}/assets`, { method: 'POST', body: form });
}

async function publishFlow(token, flowId) {
  return graph(token, `${flowId}/publish`, { method: 'POST' });
}

/**
 * Syncs a Flow JSON string to Meta under the given name.
 *
 * @param {object} opts
 * @param {string} opts.token    - WA_ACCESS_TOKEN (must have whatsapp_business_management)
 * @param {string} opts.wabaId   - WA_WABA_ID (your WABA ID, not the phone number ID)
 * @param {string} opts.flowJson - raw JSON string (caller should JSON.parse it first to fail fast)
 * @param {string} opts.name     - Flow name as it appears in Meta
 * @param {(line: string) => void} [opts.onLog] - called with each progress line, e.g. console.log
 * @returns {Promise<{flowId: string, published: boolean, log: string[]}>}
 */
async function syncFlow({ token, wabaId, flowJson, name, onLog = () => {} }) {
  if (!token || !wabaId) {
    throw new Error('Missing WA_ACCESS_TOKEN or WA_BUSINESS_ACCOUNT_ID.');
  }

  const log = [];
  const emit = (line) => { log.push(line); onLog(line); };

  emit(`🔍 Checking for an existing flow named "${name}"...`);
  const existing = await findFlowByName(token, wabaId, name);
  let flowId;

  if (existing) {
    flowId = existing.id;
    emit(`✅ Found existing flow ${flowId} (status: ${existing.status}).`);
  } else {
    emit('➕ No existing flow with that name — creating one...');
    flowId = await createFlow(token, wabaId, name);
    emit(`✅ Created flow ${flowId}.`);
  }

  emit('⬆️  Uploading flow.json...');
  const uploadResult = await uploadFlowJson(token, flowId, flowJson);
  if (uploadResult.validation_errors?.length) {
    const err = new Error('Meta rejected the Flow JSON with validation errors.');
    err.validationErrors = uploadResult.validation_errors;
    err.flowId = flowId;
    throw err;
  }
  emit('✅ JSON uploaded and validated.');

  let published = false;
  try {
    emit('📢 Publishing...');
    await publishFlow(token, flowId);
    emit('✅ Published.');
    published = true;
  } catch (err) {
    emit(`⚠️ Could not publish: ${err.message}`);
    emit('If this flow was already published and you changed its screen structure, ' +
      'Meta may require a new flow (new name) instead of editing in place.');
  }

  emit(`\nFlow ID: ${flowId}`);
  return { flowId, published, log };
}

module.exports = { syncFlow };
