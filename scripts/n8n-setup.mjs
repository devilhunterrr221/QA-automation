// One-shot setup of a local n8n instance through its public REST API:
//   1. creates (or re-creates) the "Discord – team channel" credential from DISCORD_WEBHOOK_URL
//   2. imports / updates both workflows and points their Discord nodes at that credential
//   3. sets Task 2 as its own Error Workflow and activates both workflows
//
//   node scripts/n8n-setup.mjs            (reads .env: N8N_URL, N8N_API_KEY, DISCORD_WEBHOOK_URL)
// The webhook URL only ever lives in .env (gitignored) and in n8n's encrypted credential store.
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const BASE = (env.N8N_URL || 'http://localhost:5678') + '/api/v1';
const H = { 'X-N8N-API-KEY': env.N8N_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' };

async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${t.slice(0, 400)}`);
  return t ? JSON.parse(t) : {};
}

// 1. credential – the API can't update credential data in place, so delete + create
const CRED_NAME = 'Discord – team channel';
const existing = (await api('GET', '/credentials?limit=100').catch(() => ({ data: [] }))).data ?? [];
for (const c of existing.filter(c => c.name === CRED_NAME)) await api('DELETE', `/credentials/${c.id}`);
const cred = await api('POST', '/credentials', { name: CRED_NAME, type: 'discordWebhookApi', data: { webhookUri: env.DISCORD_WEBHOOK_URL } });
console.log('credential', cred.id, '→', new URL(env.DISCORD_WEBHOOK_URL).host);

// 2. workflows
const files = ['task2/Task2_Workflow_NamanMalhotra.json', 'bonus/Bonus_UptimeMonitor_NamanMalhotra.json'];
let all = (await api('GET', '/workflows?limit=100')).data;
// --fresh: delete and re-create, which also wipes the monitor's stored history (static data)
if (process.argv.includes('--fresh')) {
  for (const w of all.filter(w => /HN Morning Brief|Uptime Monitor/.test(w.name))) {
    await api('POST', `/workflows/${w.id}/deactivate`).catch(() => {});
    for (let i = 0; ; i++) { // unpublishing is async in n8n 2.x – retry until the delete is accepted
      try { await api('DELETE', `/workflows/${w.id}`); break; }
      catch (e) { if (i > 10 || !/409/.test(e.message)) throw e; await new Promise(r => setTimeout(r, 1500)); }
    }
  }
  all = [];
}
const ids = {};
for (const f of files) {
  const wf = JSON.parse(fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8'));
  for (const n of wf.nodes) if (n.credentials?.discordWebhookApi) n.credentials.discordWebhookApi = { id: cred.id, name: CRED_NAME };
  const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings };
  const found = all.find(w => w.name === wf.name);
  if (found) await api('POST', `/workflows/${found.id}/deactivate`).catch(() => {});
  const saved = found ? await api('PUT', `/workflows/${found.id}`, body) : await api('POST', '/workflows', body);
  ids[f] = saved.id;
  console.log(found ? 'updated' : 'created', saved.id, wf.name);
}

// 3. publish both, then make Task 2 its own Error Workflow (n8n 2.x requires the error
//    workflow to already have a published version) and publish again
for (const id of Object.values(ids)) await api('POST', `/workflows/${id}/activate`);
const t2 = ids[files[0]];
const t2wf = await api('GET', `/workflows/${t2}`);
await api('PUT', `/workflows/${t2}`, {
  name: t2wf.name, nodes: t2wf.nodes, connections: t2wf.connections,
  settings: { ...t2wf.settings, errorWorkflow: t2 },
});
await api('POST', `/workflows/${t2}/activate`);
console.log('activated', Object.values(ids).join(', '), '· Task 2 error workflow → itself');
fs.writeFileSync(new URL('../n8n-ids.local.json', import.meta.url), JSON.stringify(ids, null, 2));
