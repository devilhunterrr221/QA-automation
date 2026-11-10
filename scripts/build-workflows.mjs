// Generates the two n8n workflow exports from readable JavaScript.
//   node scripts/build-workflows.mjs
// Output: task2/Task2_Workflow_NamanMalhotra.json, bonus/Bonus_UptimeMonitor_NamanMalhotra.json
// The Code-node bodies live here as plain JS so they can be read/reviewed without JSON escaping.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const DISCORD_CRED = { discordWebhookApi: { id: 'discordTeamHook1', name: 'Discord – team channel' } };
const id = () => randomUUID();
const at = (x, y) => [x, y];

const code = (name, pos, js, extra = {}) => ({
  id: id(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos,
  parameters: { jsCode: js.trim() + '\n', ...(extra.mode ? { mode: extra.mode } : {}) },
  ...(extra.node || {}),
});
const discord = (name, pos, username, extra = {}) => ({
  id: id(), name, type: 'n8n-nodes-base.discord', typeVersion: 2, position: pos,
  parameters: { authentication: 'webhook', operation: 'sendLegacy', content: '={{ $json.content }}', options: { username, wait: true } },
  credentials: DISCORD_CRED,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 3000,
  ...extra,
});
const http = (name, pos, url, extra = {}, options = {}) => ({
  id: id(), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos,
  parameters: { url, options: { timeout: 10000, ...options } },
  ...extra,
});
const link = (...pairs) => pairs;
// The Discord node handles its own failures when "continue" is on and emits { error } on its
// SUCCESS output (its error output never fires – found by forcing a 500). So every send is
// followed by an explicit check instead of relying on the error output.
const delivered = (name, pos) => ({
  id: id(), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: id(), leftValue: '={{ !$json.error && !!$json.id }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    options: {},
  },
}); // [fromName, outputIndex, toName]
function connections(list) {
  const c = {};
  for (const [from, out, to, toIndex = 0] of list) {
    c[from] ??= { main: [] };
    while (c[from].main.length <= out) c[from].main.push([]);
    c[from].main[out].push({ node: to, type: 'main', index: toIndex });
  }
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// TASK 2 – Hacker News "Morning Brief"
// ─────────────────────────────────────────────────────────────────────────────
const T2 = {};

T2.top5 = `
// Algolia returns ~30 front-page stories. Keep real stories, rank by points, keep the top 5
// and reshape each one to only what the digest needs.
const hits = $input.first().json.hits ?? [];
if (!hits.length) {
  // An empty front page means the upstream API changed or broke – fail loudly (→ Error Trigger).
  throw new Error('HN front page returned 0 stories');
}
const now = Date.now();
return hits
  .filter(h => h.title && typeof h.points === 'number')
  .sort((a, b) => b.points - a.points)
  .slice(0, 5)
  .map((h, i) => {
    const ageHours = Math.max((now - h.created_at_i * 1000) / 3.6e6, 0.1);
    const hnLink = \`https://news.ycombinator.com/item?id=\${h.objectID}\`;
    return {
      json: {
        rank: i + 1,
        id: Number(h.objectID),
        title: h.title.trim(),
        url: h.url || hnLink,
        hnLink,
        // (the Code-node sandbox has no URL global, so parse the host with a regex)
        domain: h.url ? ((h.url.match(/^https?:\\/\\/(?:www\\.)?([^/:?#]+)/i) || [])[1] || 'link') : 'news.ycombinator.com',
        author: h.author,
        points: h.points,
        comments: h.num_comments ?? 0,
        ageHours: Math.round(ageHours * 10) / 10,
      },
    };
  });
`;

T2.mergeLive = `
// Combine each Algolia story with its live record from the official HN API.
// The enrichment node runs with "On Error: Continue", so a failed lookup arrives here as
// { error } – we then keep the Algolia values and count the failure instead of crashing.
const base = $('Top 5 by Points').all();
const live = $input.all();
let enrichFailures = 0;

const stories = base.map((b, i) => {
  const s = { ...b.json };
  const l = live[i]?.json ?? {};
  if (l.error || typeof l.score !== 'number') {
    enrichFailures++;
    s.live = false;
    s.topCommentId = 0;
  } else {
    s.live = true;
    s.points = l.score;                         // live score (Algolia index can lag minutes)
    s.comments = l.descendants ?? s.comments;   // live comment count
    s.topCommentId = Array.isArray(l.kids) && l.kids.length ? l.kids[0] : 0; // kids[] is in rank order
  }
  s.pointsPerHour = Math.round(s.points / Math.max(s.ageHours, 0.1));
  return s;
});

stories.sort((a, b) => b.points - a.points).forEach((s, i) => (s.rank = i + 1));
if (enrichFailures) console.warn(\`[HN brief] live stats failed for \${enrichFailures}/\${stories.length} stories – using cached values\`);

return [{ json: { stories, top: stories[0], enrichFailures, generatedAt: new Date().toISOString() } }];
`;

T2.compose = `
// Build the Discord message (Discord hard limit: 2,000 characters).
const digest = $('Breakout Header').isExecuted ? $('Breakout Header').first().json : $('Regular Header').first().json;
const comment = $input.first().json;

const decode = (html = '') => html
  .replace(/<p>/g, ' ').replace(/<[^>]+>/g, '')
  .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&#x2F;/g, '/')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
  .replace(/\\s+/g, ' ').trim();

const HOT = 300; // per-story marker, see README
const lines = digest.stories.map(s =>
  \`\${s.points >= HOT ? '🔥' : '▫️'} **\${s.rank}. [\${s.title}](<\${s.url}>)**\\n\` +
  \`    \${s.points} pts · \${s.comments} comments · \${s.pointsPerHour} pts/h · \${s.domain} · [discuss](<\${s.hnLink}>)\`);

let commentLine;
if (comment.error || !comment.text) {
  commentLine = '💬 _Top comment unavailable – enrichment skipped_';
} else {
  const t = decode(comment.text);
  commentLine = \`💬 **Top comment on #1** (\${comment.by}): “\${t.length > 280 ? t.slice(0, 277) + '…' : t}”\`;
}

const footer = [];
if (digest.enrichFailures) footer.push(\`⚠️ Live stats unavailable for \${digest.enrichFailures}/5 stories – showing cached values.\`);
footer.push(\`-# HN Algolia + official HN API · \${new Date(digest.generatedAt).toUTCString()}\`);

let content = [digest.headline, '', ...lines, '', commentLine, '', ...footer].join('\\n');
if (content.length > 1990) content = content.slice(0, 1989) + '…';

return [{ json: {
  content,
  mode: digest.mode,
  topPoints: digest.top.points,
  enrichFailures: digest.enrichFailures,
  topCommentOk: !comment.error && !!comment.text,
} }];
`;

T2.fetchAlert = `
// Error output of "HN Front Page": the call failed after 3 attempts.
const e = $input.first().json.error ?? $input.first().json;
const msg = String(typeof e === 'string' ? e : (e.message || JSON.stringify(e)))
  .replace(/\\\\n/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 300); // HTML error pages → one line
console.error('[HN brief] front-page fetch failed:', msg);
return [{ json: {
  content: [
    '⚠️ **HN Morning Brief – no digest this run**',
    'Could not fetch the Hacker News front page after 3 attempts.',
    \`> \${msg}\`,
    \`Execution #\${$execution.id} · next attempt at the next scheduled run.\`,
  ].join('\\n'),
} }];
`;

T2.deliveryFailed = `
// Error output of "Post Digest": Discord refused / was unreachable 3 times in a row.
// We can't alert on the channel that is down, so: log it, then fail the execution on purpose
// (red in the Executions list + Error Workflow fires) instead of finishing "green".
const e = $input.first().json.error ?? $input.first().json;
const msg = String(e.message || JSON.stringify(e)).slice(0, 400);
console.error('[HN brief] Discord delivery failed:', msg);
return [{ json: { reason: msg } }];
`;

T2.crash = `
// Error Trigger: anything that was not handled above (e.g. a Code node threw).
const x = $input.first().json;
const node = x.execution?.lastNodeExecuted ?? 'unknown node';
const msg = x.execution?.error?.message ?? 'unknown error';
console.error('[HN brief] workflow crashed in', node, '-', msg);
return [{ json: { content: [
  \`🛑 **Workflow crashed: \${x.workflow?.name ?? 'HN Morning Brief'}**\`,
  \`Node: \\\`\${node}\\\`\`,
  \`Error: \${msg}\`,
  x.execution?.url ? \`Execution: \${x.execution.url}\` : '',
].filter(Boolean).join('\\n') } }];
`;

const t2Nodes = [
  { id: id(), name: 'Every Hour', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: at(0, 200),
    parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } } },
  { id: id(), name: 'GET /webhook/hn-brief', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: at(0, 400),
    webhookId: 'b7c4a6f2-5d0e-4b8a-9c3e-7a1e2b3c4d5f',
    parameters: { path: 'hn-brief', httpMethod: 'GET', responseMode: 'onReceived', options: {} } },
  http('HN Front Page', at(240, 300), "=https://hn.algolia.com/api/v1/{{ $json.query?.simulate === 'fetch_fail' ? 'does-not-exist' : 'search' }}?tags=front_page&hitsPerPage=30",
    { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: 'continueErrorOutput' }),
  code('Top 5 by Points', at(480, 200), T2.top5),
  http('Live Stats (HN API)', at(720, 200), "=https://hacker-news.firebaseio.com/v0/{{ $('GET /webhook/hn-brief').isExecuted && $('GET /webhook/hn-brief').first().json.query?.simulate === 'enrich_fail' ? 'no-such-path' : 'item' }}/{{ $json.id }}.json",
    { retryOnFail: true, maxTries: 2, waitBetweenTries: 1000, onError: 'continueRegularOutput' }, { timeout: 8000 }),
  code('Merge Live Stats', at(960, 200), T2.mergeLive),
  { id: id(), name: '#1 has ≥ 500 points?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: at(1200, 200),
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ id: id(), leftValue: '={{ $json.top.points }}', rightValue: 500, operator: { type: 'number', operation: 'gte' } }],
        combinator: 'and',
      },
      options: {},
    } },
  { id: id(), name: 'Breakout Header', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: at(1440, 100),
    parameters: { includeOtherFields: true, options: {}, assignments: { assignments: [
      { id: id(), name: 'mode', type: 'string', value: 'breakout' },
      { id: id(), name: 'headline', type: 'string', value: '=🚨 **Big story on Hacker News** – #1 is at {{ $json.top.points }} points\n☕ HN Morning Brief · top 5 right now' },
    ] } } },
  { id: id(), name: 'Regular Header', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: at(1440, 300),
    parameters: { includeOtherFields: true, options: {}, assignments: { assignments: [
      { id: id(), name: 'mode', type: 'string', value: 'regular' },
      { id: id(), name: 'headline', type: 'string', value: '☕ **HN Morning Brief** · top 5 right now' },
    ] } } },
  http('Top Comment (HN API)', at(1680, 200), '=https://hacker-news.firebaseio.com/v0/item/{{ $json.top.topCommentId }}.json',
    { retryOnFail: true, maxTries: 2, waitBetweenTries: 1000, onError: 'continueRegularOutput', alwaysOutputData: true }, { timeout: 8000 }),
  code('Compose Digest', at(1920, 200), T2.compose),
  discord('Post Digest', at(2160, 200), 'HN Morning Brief', { onError: 'continueRegularOutput' }),
  delivered('Delivered?', at(2400, 200)),
  code('Log Delivery Failure', at(2640, 300), T2.deliveryFailed),
  { id: id(), name: 'Fail Execution', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: at(2880, 300),
    parameters: { errorMessage: '=Digest could not be delivered to Discord after 3 attempts: {{ $json.reason }}' } },
  code('Format Fetch Alert', at(480, 460), T2.fetchAlert),
  discord('Post Fetch Alert', at(720, 460), 'HN Brief – alerts'),
  { id: id(), name: 'On Workflow Error', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: at(0, 680), parameters: {} },
  code('Format Crash Alert', at(240, 680), T2.crash),
  discord('Post Crash Alert', at(480, 680), 'HN Brief – alerts', { onError: 'continueRegularOutput' }),
];

const t2Links = [
  ['Every Hour', 0, 'HN Front Page'],
  ['GET /webhook/hn-brief', 0, 'HN Front Page'],
  ['HN Front Page', 0, 'Top 5 by Points'],
  ['HN Front Page', 1, 'Format Fetch Alert'],
  ['Top 5 by Points', 0, 'Live Stats (HN API)'],
  ['Live Stats (HN API)', 0, 'Merge Live Stats'],
  ['Merge Live Stats', 0, '#1 has ≥ 500 points?'],
  ['#1 has ≥ 500 points?', 0, 'Breakout Header'],
  ['#1 has ≥ 500 points?', 1, 'Regular Header'],
  ['Breakout Header', 0, 'Top Comment (HN API)'],
  ['Regular Header', 0, 'Top Comment (HN API)'],
  ['Top Comment (HN API)', 0, 'Compose Digest'],
  ['Compose Digest', 0, 'Post Digest'],
  ['Post Digest', 0, 'Delivered?'],
  ['Delivered?', 1, 'Log Delivery Failure'],
  ['Log Delivery Failure', 0, 'Fail Execution'],
  ['Format Fetch Alert', 0, 'Post Fetch Alert'],
  ['On Workflow Error', 0, 'Format Crash Alert'],
  ['Format Crash Alert', 0, 'Post Crash Alert'],
];

const sticky = (content, pos, w, h, color = 7) => ({
  id: id(), name: 'Note ' + Math.random().toString(36).slice(2, 7), type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: pos,
  parameters: { content, width: w, height: h, color },
});

const task2 = {
  name: 'Task 2 – HN Morning Brief',
  nodes: [
    ...t2Nodes,
    sticky('## HN Morning Brief\nHourly (or `curl localhost:5678/webhook/hn-brief`).\n1. Algolia: front page → **top 5 by points**\n2. Official HN API: **live score + top comment**\n3. IF #1 ≥ 500 pts → "big story" header\n4. Post to Discord (credential, no secrets in nodes)', at(-40, -40), 420, 200, 4),
    sticky('### Error paths\n• Front-page fetch: 3 tries → error output → Discord alert\n• Enrichment: continue on fail → digest still sent, marked ⚠️\n• Discord: 3 tries → \"Delivered?\" check → log → Stop and Error (execution fails visibly → crash alert)\n• Anything else → Error Trigger → crash alert', at(940, 420), 460, 170, 3),
  ],
  connections: connections(t2Links),
  settings: { executionOrder: 'v1', saveManualExecutions: true, saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all', timezone: 'Asia/Kolkata' },
  pinData: {},
  meta: { templateCredsSetupCompleted: false },
  tags: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// BONUS – Uptime monitor for the Task 1 app
// ─────────────────────────────────────────────────────────────────────────────
const B = {};

B.targets = `
// What to watch. Both halves of the Task 1 app: the frontend (must contain "Conduit" – catches
// a 200 that serves the wrong page) and the API it depends on.
// Manual/demo run: GET /webhook/uptime-check?probe=<url> adds one extra target, e.g. a URL that 404s.
const probe = $input.first().json.query?.probe;
const targets = [
  { name: 'Conduit frontend', url: 'https://demo.realworld.show/', expect: 'Conduit' },
  { name: 'Conduit API', url: 'https://api.realworld.show/api/tags', expect: '"tags"' },
];
if (probe) targets.push({ name: 'Test probe', url: probe, expect: '' });
return targets.map(t => ({ json: t }));
`;

B.start = `
// Stamp the start time right before this target's request (runs once per loop iteration).
return [{ json: { ...$input.first().json, startedAt: Date.now() } }];
`;

B.evaluate = `
// Turn the raw HTTP result into a check result. The Ping node retries 3× (5 s apart) and then
// continues on fail, so a dead target shows up here as { error } instead of stopping the run.
const SLOW_MS = 3000;
// Runs once per item: .item follows the paired-item link back to *this* iteration's Start Timer.
const t = $('Start Timer').item.json;
const r = $input.item.json;
const ms = Date.now() - t.startedAt;            // includes retries = "time until a usable answer"

let status = r.statusCode ?? 0;
let error = null;
if (r.error) {
  const m = typeof r.error === 'string' ? r.error : (r.error.message || JSON.stringify(r.error));
  error = String(m).slice(0, 300);
  status = Number(r.error.httpCode || (String(m).match(/\\b([1-5]\\d\\d)\\b/) || [])[1] || 0); // 0 = timeout / DNS / TLS
}
const raw = r.data ?? r.body ?? '';                // full-response mode puts the body in .data
const body = typeof raw === 'string' ? raw : JSON.stringify(raw);
const contentOk = !t.expect || body.includes(t.expect);
const up = status === 200 && contentOk;

return { json: {
  name: t.name, url: t.url, status, ms, up,
  slow: up && ms > SLOW_MS,
  contentOk,
  error: error ?? (status === 200 && !contentOk ? \`200 OK but body did not contain "\${t.expect}"\` : null),
  checkedAt: new Date().toISOString(),
} };
`;

B.decide = `
// Keep 26 h of history + per-target state in workflow static data (persists between
// production runs), and decide what is worth a notification:
//   • DOWN (first failed check)        → alert immediately
//   • still down                        → reminder every 30 min, not every 5 min (no alert spam)
//   • back up                           → recovery message with downtime duration
//   • up but slower than 3 s            → "slow" warning (max once per 30 min)
const REMIND_MS = 30 * 60 * 1000;
const results = $input.all().map(i => i.json);
const store = $getWorkflowStaticData('global');
store.history ??= [];
store.state ??= {};
const now = Date.now();

for (const r of results) store.history.push({ t: now, name: r.name, up: r.up, ms: r.ms, status: r.status });
store.history = store.history.filter(h => now - h.t < 26 * 3600e3);

const fmtDur = ms => ms < 3600e3 ? \`\${Math.round(ms / 60000)} min\` : \`\${(ms / 3600e3).toFixed(1)} h\`;
const lines = [];
for (const r of results) {
  const s = store.state[r.name] ?? { up: true, since: now, lastAlert: 0, lastSlow: 0, incidents: 0 };
  const what = r.status === 200 ? 'HTTP 200 but wrong content' : r.status ? \`HTTP \${r.status} after 3 attempts\` : 'no response after 3 attempts';
  if (!r.up) {
    if (s.up) {
      s.since = now; s.lastAlert = now; s.incidents = (s.incidents || 0) + 1;
      lines.push(\`🔴 **\${r.name} is DOWN** – \${what} (\${r.ms} ms)\\n    \${r.url}\${r.error ? \`\\n    > \${r.error}\` : ''}\`);
    } else if (now - s.lastAlert >= REMIND_MS) {
      s.lastAlert = now;
      lines.push(\`🔴 **\${r.name} still down** for \${fmtDur(now - s.since)} – \${what}\`);
    }
    s.up = false;
  } else {
    if (!s.up) {
      lines.push(\`🟢 **\${r.name} recovered** after \${fmtDur(now - s.since)} – HTTP 200 in \${r.ms} ms\`);
      s.since = now;
    } else if (r.slow && now - (s.lastSlow || 0) >= REMIND_MS) {
      s.lastSlow = now;
      lines.push(\`🟡 **\${r.name} is slow** – \${r.ms} ms (threshold 3000 ms)\`);
    }
    s.up = true;
  }
  store.state[r.name] = s;
}

const summary = results.map(r => \`\${r.up ? '✅' : '❌'} \${r.name}: \${r.status || '—'} in \${r.ms} ms\`).join(' · ');
return [{ json: {
  alertCount: lines.length,
  content: lines.length ? [...lines, '', \`-# Uptime monitor · \${new Date().toUTCString()}\`].join('\\n').slice(0, 1990) : '',
  summary,
  results,
} }];
`;

B.daily = `
// Daily 09:00 summary from the stored history (last 24 h).
const store = $getWorkflowStaticData('global');
const now = Date.now();
const hist = (store.history ?? []).filter(h => now - h.t < 24 * 3600e3);
if (!hist.length) {
  return [{ json: { content: '📊 **Daily uptime summary** – no checks recorded in the last 24 h. Is the monitor workflow active?' } }];
}
const names = [...new Set(hist.map(h => h.name))].filter(n => n !== 'Test probe');
const pct = (a, b) => (b ? (100 * a / b).toFixed(2) : '0.00');
const lines = names.map(n => {
  const h = hist.filter(x => x.name === n);
  const up = h.filter(x => x.up);
  const times = up.map(x => x.ms).sort((a, b) => a - b);
  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  const p95 = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] : 0;
  const downChecks = h.length - up.length;
  return \`\${downChecks ? '⚠️' : '✅'} **\${n}** – uptime **\${pct(up.length, h.length)}%** (\${h.length} checks, \${downChecks} failed)\\n    avg \${avg} ms · p95 \${p95} ms · max \${times.at(-1) ?? 0} ms · incidents so far: \${store.state?.[n]?.incidents ?? 0}\`;
});
return [{ json: { content: ['📊 **Daily uptime summary** (last 24 h)', '', ...lines].join('\\n') } }];
`;

B.deliveryFailed = `
const e = $input.first().json.error ?? $input.first().json;
console.error('[uptime] Discord delivery failed:', String(e.message || JSON.stringify(e)).slice(0, 300));
return [{ json: { reason: String(e.message || 'unknown').slice(0, 300) } }];
`;

const bonusNodes = [
  { id: id(), name: 'Every 5 Minutes', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: at(0, 200),
    parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } } },
  { id: id(), name: 'GET /webhook/uptime-check', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: at(0, 400),
    webhookId: 'c2d9e1f0-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
    parameters: { path: 'uptime-check', httpMethod: 'GET', responseMode: 'onReceived', options: {} } },
  code('Targets', at(240, 300), B.targets),
  { id: id(), name: 'Loop Targets', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: at(480, 300),
    parameters: { batchSize: 1, options: {} } },
  code('Start Timer', at(720, 400), B.start),
  http('Ping', at(960, 400), '={{ $json.url }}',
    { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueRegularOutput' },
    { timeout: 10000, response: { response: { fullResponse: true, responseFormat: 'text' } } }),
  code('Evaluate Check', at(1200, 400), B.evaluate, { mode: 'runOnceForEachItem' }),
  code('Update History & Decide', at(720, 160), B.decide),
  { id: id(), name: 'Anything to report?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: at(960, 160),
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ id: id(), leftValue: '={{ $json.alertCount }}', rightValue: 0, operator: { type: 'number', operation: 'gt' } }],
        combinator: 'and',
      },
      options: {},
    } },
  discord('Post Uptime Alert', at(1200, 60), 'Uptime Monitor', { onError: 'continueRegularOutput' }),
  delivered('Delivered?', at(1440, 60)),
  { id: id(), name: 'All Healthy', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: at(1200, 240), parameters: {} },
  code('Log Delivery Failure', at(1680, 140), B.deliveryFailed),
  { id: id(), name: 'Fail Execution', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: at(1920, 140),
    parameters: { errorMessage: '=Uptime alert could not be delivered to Discord: {{ $json.reason }}' } },
  { id: id(), name: 'Daily 09:00', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: at(0, 640),
    parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 9, triggerAtMinute: 0 }] } } },
  { id: id(), name: 'GET /webhook/uptime-summary', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: at(0, 820),
    webhookId: 'd3e0f2a1-7b8c-4d9e-8f10-2b3c4d5e6f70',
    parameters: { path: 'uptime-summary', httpMethod: 'GET', responseMode: 'onReceived', options: {} } },
  code('Build Daily Summary', at(240, 640), B.daily),
  discord('Post Daily Summary', at(480, 640), 'Uptime Monitor'),
];

const bonusLinks = [
  ['Every 5 Minutes', 0, 'Targets'],
  ['GET /webhook/uptime-check', 0, 'Targets'],
  ['Targets', 0, 'Loop Targets'],
  ['Loop Targets', 0, 'Update History & Decide'], // "done" output → all results
  ['Loop Targets', 1, 'Start Timer'],              // "loop" output → one target
  ['Start Timer', 0, 'Ping'],
  ['Ping', 0, 'Evaluate Check'],
  ['Evaluate Check', 0, 'Loop Targets'],
  ['Update History & Decide', 0, 'Anything to report?'],
  ['Anything to report?', 0, 'Post Uptime Alert'],
  ['Anything to report?', 1, 'All Healthy'],
  ['Post Uptime Alert', 0, 'Delivered?'],
  ['Delivered?', 1, 'Log Delivery Failure'],
  ['Log Delivery Failure', 0, 'Fail Execution'],
  ['Daily 09:00', 0, 'Build Daily Summary'],
  ['GET /webhook/uptime-summary', 0, 'Build Daily Summary'],
  ['Build Daily Summary', 0, 'Post Daily Summary'],
];

const bonus = {
  name: 'Bonus – Conduit Uptime Monitor',
  nodes: [
    ...bonusNodes,
    sticky('## Uptime monitor (Task 1 app)\nEvery 5 min: frontend + API, one at a time.\n• 3 tries, 5 s apart, 10 s timeout\n• status must be 200 **and** body must look right\n• response time per check\n• alert on DOWN / reminder every 30 min / RECOVERED / SLOW > 3 s', at(-40, -40), 440, 210, 4),
    sticky('### Daily 09:00 summary\nuptime %, avg / p95 / max response time, failed checks, incidents – from 24 h of stored history', at(-40, 540), 440, 90, 5),
  ],
  connections: connections(bonusLinks),
  settings: { executionOrder: 'v1', saveManualExecutions: true, saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all', timezone: 'Asia/Kolkata' },
  pinData: {},
  meta: { templateCredsSetupCompleted: false },
  tags: [],
};

const root = new URL('..', import.meta.url);
fs.mkdirSync(new URL('task2/', root), { recursive: true });
fs.mkdirSync(new URL('bonus/', root), { recursive: true });
fs.writeFileSync(new URL('task2/Task2_Workflow_NamanMalhotra.json', root), JSON.stringify(task2, null, 2));
fs.writeFileSync(new URL('bonus/Bonus_UptimeMonitor_NamanMalhotra.json', root), JSON.stringify(bonus, null, 2));
console.log('task2 nodes:', task2.nodes.length, '· bonus nodes:', bonus.nodes.length);
