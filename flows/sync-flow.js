// CLI wrapper around syncFlowCore.js — same usage as before, just no
// longer duplicates the sync logic (that now lives in syncFlowCore.js
// so the HTTP admin route can reuse it too).
//
// Usage:
//   node flows/sync-flow.js flows/sell-item-flow.json "Sell an Item"
//
// You probably won't run this directly from your phone — use the
// /api/admin/sync-flow?key=... route instead (see README.md).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { syncFlow } = require('./syncFlowCore');

const TOKEN = process.env.WA_ACCESS_TOKEN;
const WABA_ID = process.env.WA_WABA_ID;

if (!TOKEN || !WABA_ID) {
  console.error('❌ Set WA_ACCESS_TOKEN and WA_WABA_ID in your .env first.');
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

syncFlow({ token: TOKEN, wabaId: WABA_ID, flowJson, name: nameArg, onLog: console.log })
  .then(({ flowId }) => {
    console.log(`Add this to your .env: WA_SELL_FLOW_ID=${flowId}`);
  })
  .catch((err) => {
    console.error('❌', err.message);
    if (err.validationErrors) console.error(JSON.stringify(err.validationErrors, null, 2));
    process.exit(1);
  });
