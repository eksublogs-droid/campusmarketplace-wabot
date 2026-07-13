// Syncs a local Flow JSON file to Meta as a published WhatsApp Flow —
// so you can edit flows/sell-item-flow.json in your editor and push
// changes with one command, instead of copy-pasting into the Flow Builder
// UI every time.
//
// Requires in your .env:
//   WA_ACCESS_TOKEN         - must have the whatsapp_business_management
//                              permission (your regular messaging token
//                              usually does NOT have this — check under
//                              your app's permissions in Meta App Dashboard)
//   WA_BUSINESS_ACCOUNT_ID  - your WABA ID (NOT the phone number ID).
//                              Find it in WhatsApp Manager > Business
//                              Settings, or via GET /me/businesses.
//
// Usage:
//   node flows/sync-flow.js flows/sell-item-flow.json "Sell an Item"
//
// First run: creates the flow (status DRAFT), uploads the JSON, publishes it,
//            and prints the Flow ID to put in WA_SELL_FLOW_ID.
// Later runs: finds the existing flow by name, re-uploads the JSON, re-publishes.
//
// Note: once a flow is PUBLISHED, Meta won't let you edit it in place if it
// has certain structural changes — in that case this script will tell you
// to create a new flow (new name) and swap the ID in .env instead.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const GRAPH_VERSION = 'v20.0';
const TOKEN = process.env.WA_ACCESS_TOKEN;
const WABA_ID = process.env.WA_BUSINESS_ACCOUNT_ID;

if (!TOKEN || !WABA_ID) {
  console.error('❌ Set WA_ACCESS_TOKEN and WA_BUSINESS_ACCOUNT_ID in your .env first.');
  process.exit(1);
}

const [, , jsonPathArg, nameArg] = process.argv;
if (!jsonPathArg || !nameArg) {
  console.error('Usage: node flows/sync-flow.js <path-to-flow.json> "<Flow Name>"');
  process.exit(1);
}

const jsonPath = path.resolve(jsonPathArg);
const flowJson = fs.readFileSync(jsonPath, 'utf8');
JSON.parse(flowJson); // fail fast on invalid JSON before hitting the API

async function graph(pathSuffix, options = {}) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pathSuffix}`, {
    ...options,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Graph API error (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function findFlowByName(name) {
  const data = await graph(`${WABA_ID}/flows?fields=id,name,status`);
  return (data.data || []).find(f => f.name === name);
}

async function createFlow(name) {
  const data = await graph(`${WABA_ID}/flows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, categories: ['OTHER'] })
  });
  return data.id;
}

async function uploadFlowJson(flowId) {
  const form = new FormData();
  form.append('file', new Blob([flowJson], { type: 'application/json' }), 'flow.json');
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  return graph(`${flowId}/assets`, { method: 'POST', body: form });
}

async function publishFlow(flowId) {
  return graph(`${flowId}/publish`, { method: 'POST' });
}

async function main() {
  console.log(`🔍 Checking for an existing flow named "${nameArg}"...`);
  let flow = await findFlowByName(nameArg);
  let flowId;

  if (flow) {
    flowId = flow.id;
    console.log(`✅ Found existing flow ${flowId} (status: ${flow.status}).`);
  } else {
    console.log('➕ No existing flow with that name — creating one...');
    flowId = await createFlow(nameArg);
    console.log(`✅ Created flow ${flowId}.`);
  }

  console.log('⬆️  Uploading flow.json...');
  const uploadResult = await uploadFlowJson(flowId);
  if (uploadResult.validation_errors?.length) {
    console.error('❌ Meta rejected the Flow JSON with validation errors:');
    console.error(JSON.stringify(uploadResult.validation_errors, null, 2));
    process.exit(1);
  }
  console.log('✅ JSON uploaded and validated.');

  try {
    console.log('📢 Publishing...');
    await publishFlow(flowId);
    console.log('✅ Published.');
  } catch (err) {
    console.error(`⚠️ Could not publish: ${err.message}`);
    console.error('If this flow was already published and you changed its screen structure, ' +
      'Meta may require a new flow (new name) instead of editing in place.');
  }

  console.log(`\nFlow ID: ${flowId}`);
  console.log(`Add this to your .env: WA_SELL_FLOW_ID=${flowId}`);
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
