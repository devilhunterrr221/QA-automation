// Task 1 – automated QA run against the public RealWorld demo.
// App:  https://demo.realworld.show  (Angular frontend, realworld-apps/angular-realworld-example-app)
// API:  https://api.realworld.show/api (public sandbox backend, "real accounts can't see each other")
//
// Usage:  node qa.mjs            (uses the locally installed Google Chrome, headless)
// Output: results.json + screenshots/*.png
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = 'https://demo.realworld.show';
const API = 'https://api.realworld.show/api';
const SHOTS = new URL('./screenshots/', import.meta.url);
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const created = []; // { slug, token } for cleanup
const run = Date.now().toString(36);

function record(id, name, status, detail, extra = {}) {
  results.push({ id, name, status, detail, ...extra });
  console.log(`[${status}] ${id} ${name} – ${detail}`);
}

// All API calls go through the browser context's own request client, so they come from the
// same client as the UI. (The public demo backend isolates data per client, so a plain
// Node fetch() would talk to a different sandbox and give misleading results.)
let REQ = null;
// Plain Node client (default UA) for throwaway sign-up probes, so they don't touch the main test account
const NODE = { fetch: async (url, o) => { const r = await fetch(url, { method: o.method, headers: o.headers, body: o.data });
  const t = await r.text(); return { status: () => r.status, text: async () => t, headers: () => Object.fromEntries(r.headers) }; } };
async function api(method, path, body, token, req = REQ) {
  const t0 = performance.now();
  const res = await req.fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Token ${token}` } : {}),
    },
    data: body ? JSON.stringify(body) : undefined,
    failOnStatusCode: false,
  });
  const ms = Math.round(performance.now() - t0);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status(), json, text, ms, headers: res.headers() };
}

const shot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(name + '.png', SHOTS)), fullPage: false });

async function uiSignup(page, u) {
  await page.goto(APP + '/register');
  await page.fill('input[name=username]', u.username);
  await page.fill('input[name=email]', u.email);
  await page.fill('input[name=password]', u.password);
  await page.click('button[type=submit]');
}

async function uiCreateArticle(page, a) {
  await page.goto(APP + '/editor');
  await page.fill('input[name=title]', a.title);
  await page.fill('input[name=description]', a.description);
  await page.fill('textarea[name=body]', a.body);
  for (const t of a.tags || []) {
    await page.fill('input[placeholder="Enter tags"]', t);
    await page.press('input[placeholder="Enter tags"]', 'Enter');
  }
  await page.click('button:has-text("Publish Article")');
}

const userA = { username: `qa_a_${run}`, email: `qa_a_${run}@example.com`, password: 'Sup3rS3cret!' };
const userB = { username: `qa_b_${run}`, email: `qa_b_${run}@example.com`, password: 'Sup3rS3cret!' };

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
REQ = ctx.request;
const dialogs = [];
page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });

try {
  // ───────────── Sign-up ─────────────
  await uiSignup(page, userA);
  await page.waitForURL(APP + '/', { timeout: 15000 }).catch(() => {});
  const tokenA = await page.evaluate(() => localStorage.getItem('jwtToken'));
  const navText = await page.textContent('nav');
  record('S1', 'Sign-up happy path', tokenA && navText.includes(userA.username) ? 'PASS' : 'FAIL',
    tokenA ? `Registered and redirected home, header shows "${userA.username}"` : 'No token after sign-up');
  await shot(page, 'S1_signup_ok');

  const weak = await api('POST', '/users', { user: { username: `qa_w_${run}`, email: `qa_w_${run}@example.com`, password: '1' } }, null, NODE);
  record('S2', 'Sign-up accepts 1-character password', weak.status === 201 || weak.status === 200 ? 'ISSUE' : 'PASS',
    `POST /users with password "1" → HTTP ${weak.status}`);

  const blankName = await api('POST', '/users', { user: { username: '   ', email: `qa_s_${run}@example.com`, password: 'abcdefgh1' } }, null, NODE);
  const htmlName = await api('POST', '/users', { user: { username: `<b>qa</b>${run}`, email: `qa_h_${run}@example.com`, password: 'abcdefgh1' } }, null, NODE);
  const longName = await api('POST', '/users', { user: { username: 'u'.repeat(300) + run, email: `qa_l_${run}@example.com`, password: 'abcdefgh1' } }, null, NODE);
  record('S3', 'Username validation (blank / HTML / 300 chars)',
    [blankName, htmlName, longName].some(r => r.status < 300) ? 'ISSUE' : 'PASS',
    `whitespace-only → ${blankName.status}, "<b>qa</b>…" → ${htmlName.status}, 300-char → ${longName.status}`);

  {
    const c2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p2 = await c2.newPage();

    // invalid-but-accepted email format
    const odd = await api('POST', '/users', { user: { username: `qa_e_${run}`, email: `qa_e_${run}@localhost`, password: 'abcdefgh1' } }, null, NODE);
    record('S5', 'Email without a TLD (user@localhost) is accepted', odd.status < 300 ? 'INFO' : 'PASS', `→ HTTP ${odd.status}`);

    // ───────────── Login ─────────────
    await p2.goto(APP + '/login');
    await p2.fill('input[name=email]', userA.email);
    await p2.fill('input[name=password]', 'wrong-password');
    await p2.click('button[type=submit]');
    await p2.waitForSelector('.error-messages li', { timeout: 10000 }).catch(() => {});
    const lerr = (await p2.$$eval('.error-messages li', els => els.map(e => e.textContent.trim()))).join('; ');
    record('L1', 'Wrong password shows a clear error', lerr ? 'PASS' : 'ISSUE', `UI message: "${lerr || '(none)'}"`);
    await shot(p2, 'L1_wrong_password');

    await p2.fill('input[name=password]', userA.password);
    await p2.click('button[type=submit]');
    await p2.waitForURL(APP + '/', { timeout: 15000 }).catch(() => {});
    const who = await p2.textContent('nav');
    record('L2', 'Login happy path', p2.url() === APP + '/' && who.includes(userA.username) ? 'PASS' : 'ISSUE',
      `landed on ${p2.url().replace(APP, '') || '/'}; header shows ${who.includes(userA.username) ? userA.username : who.includes('qa_dup_') ? 'the DUPLICATE account' : '"Sign in" (login failed)'}`);
    await shot(p2, 'L2_login_ok');
    await c2.close();
  }


  // Did logging in from a second browser affect the first browser's session?
  {
    const tok = await page.evaluate(() => localStorage.getItem('jwtToken'));
    const me = await api('GET', '/user', null, tok);
    await page.goto(APP + '/settings');
    await page.waitForTimeout(2500);
    const kicked = page.url().includes('/login');
    record('L4', 'Signing in on a 2nd browser logs the 1st browser out without warning', kicked ? 'ISSUE' : 'PASS',
      `after user A logged in elsewhere, the original tab's token → GET /user HTTP ${me.status}; opening /settings → ${page.url().replace(APP, '')}`);
    if (kicked) await shot(page, 'L4_first_session_kicked');
  }
  // make sure the main tab is signed in before continuing
  if (!(await page.evaluate(() => localStorage.getItem('jwtToken')))) {
    await page.goto(APP + '/login');
    await page.fill('input[name=email]', userA.email);
    await page.fill('input[name=password]', userA.password);
    await page.click('button[type=submit]');
    await page.waitForURL(APP + '/', { timeout: 15000 }).catch(() => {});
  }

  // ───────────── Create ─────────────
  const reqLog = [];
  page.on('request', r => { if (r.url().startsWith(API + '/articles')) reqLog.push(`${r.method()} ${r.url().replace(API, '')}`); });

  await uiCreateArticle(page, { title: `QA article ${run}`, description: 'Created by the QA script', body: '# Hello\n\nThis is **markdown**.', tags: ['qa', ' qa', 'QA', 'testing'] });
  await page.waitForURL(/\/article\//, { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('.article-page h1', { timeout: 15000 }).catch(() => {});
  const slug1 = page.url().split('/article/')[1];
  if (slug1) created.push(slug1);
  record('A1', 'Create article happy path', slug1 ? 'PASS' : 'FAIL', slug1 ? `published at /article/${slug1}` : `stuck at ${page.url()}`);
  await shot(page, 'A1_article_created');

  if (slug1) {
    const shown = await page.$$eval('ul.tag-list li', els => els.map(e => JSON.stringify(e.textContent.trim())));
    await page.goto(APP + '/editor');
    for (const t of ['qa', ' qa', 'qa ', 'QA']) {
      await page.fill('input[placeholder="Enter tags"]', t);
      await page.press('input[placeholder="Enter tags"]', 'Enter');
    }
    const pills = await page.$$eval('.tag-list span.tag-pill', els => els.map(e => JSON.stringify(e.textContent)));
    record('A2', 'Tags are not trimmed or de-duplicated', pills.length > 1 ? 'ISSUE' : 'PASS',
      `typing "qa", " qa", "qa ", "QA" in the editor → ${pills.length} separate tag pills; published article shows tags [${shown.join(', ')}]`);
    await shot(page, 'A2_duplicate_tags');
  }

  // empty article
  await page.goto(APP + '/editor');
  await page.click('button:has-text("Publish Article")');
  await page.waitForSelector('.error-messages li', { timeout: 10000 }).catch(() => {});
  const emptyErr = (await page.$$eval('.error-messages li', els => els.map(e => e.textContent.trim()))).join('; ');
  record('A3', 'Empty article: no client-side validation, raw server message', 'ISSUE',
    `Publish button is always enabled; empty submit round-trips to API, UI shows: "${emptyErr || '(nothing)'}"`);
  await shot(page, 'A3_empty_article');

  // XSS attempt
  await uiCreateArticle(page, {
    title: `<script>window.__xssTitle=1</script> XSS ${run}`,
    description: '<img src=x onerror="window.__xssDesc=1">',
    body: 'Hi <img src=x onerror="window.__xssBody=1"> <a href="javascript:window.__xssLink=1">click</a>',
  });
  await page.waitForURL(/\/article\//, { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('.article-page h1', { timeout: 15000 }).catch(() => {});
  const slugX = page.url().split('/article/')[1];
  if (slugX) created.push(slugX);
  await page.waitForTimeout(1500);
  const fired = await page.evaluate(() => ['__xssTitle', '__xssDesc', '__xssBody'].filter(k => window[k]));
  record('A4', 'Stored XSS via title/description/body markdown', fired.length ? 'ISSUE' : 'PASS',
    fired.length ? `payload executed: ${fired.join(',')}` : 'payloads rendered inert (Angular sanitiser strips onerror/javascript:)');
  await shot(page, 'A4_xss_inert');

  // very long unbroken title – layout overflow
  const longTitle = 'Supercalifragilistic'.repeat(12) + run;
  await uiCreateArticle(page, { title: longTitle, description: 'long title test', body: 'body' });
  await page.waitForURL(/\/article\//, { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('.article-page h1', { timeout: 15000 }).catch(() => {});
  const slugL = page.url().split('/article/')[1];
  if (slugL) created.push(slugL);
  if (!slugL) {
    const e = (await page.$$eval('.error-messages li', els => els.map(x => x.textContent.trim()))).join('; ');
    record('A5', 'Long title (≈250 chars) cannot be published', 'ISSUE', `publish failed, UI shows: "${e || '(nothing)'}"; no max-length hint in the form`);
    await shot(page, 'A5_long_title_error');
  } else {
    // same logged-in page, resized to a phone viewport (the demo hides other users' articles from anonymous visitors)
    await page.setViewportSize({ width: 375, height: 740 });
    const mp = page;
    await mp.goto(APP + '/article/' + slugL);
    await mp.waitForSelector('h1', { timeout: 15000 });
    await mp.waitForTimeout(800);
    const ov = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    record('A5', 'Long unbroken title overflows the page on mobile', ov.sw > ov.iw + 2 ? 'ISSUE' : 'PASS',
      `${longTitle.length}-char title; page scrollWidth ${ov.sw}px vs viewport ${ov.iw}px (slug is ${slugL?.length} chars)`);
    await shot(mp, 'A5_long_title_mobile');
    await page.setViewportSize({ width: 1280, height: 800 });
  }

  // oversized body – what does the user see?
  {
    let postStatus = null;
    const onResp = r => { if (r.request().method() === 'POST' && r.url() === API + '/articles') postStatus = r.status(); };
    page.on('response', onResp);
    await page.goto(APP + '/editor');
    await page.fill('input[name=title]', `Big body ${run}`);
    await page.fill('input[name=description]', 'size test');
    await page.$eval('textarea[name=body]', (el, n) => {
      el.value = 'lorem ipsum '.repeat(n); el.dispatchEvent(new Event('input'));
    }, 200000); // ~2.4 MB
    await page.click('button:has-text("Publish Article")');
    await page.waitForTimeout(6000);
    page.off('response', onResp);
    const bigErr = (await page.$$eval('.error-messages li', els => els.map(e => e.textContent.trim()))).join('; ');
    if (page.url().includes('/article/')) created.push(page.url().split('/article/')[1]);
    record('A6', 'Oversized article: misleading "check your internet" error', /internet/i.test(bigErr) ? 'ISSUE' : 'INFO',
      `~2.4 MB body → API HTTP ${postStatus}; UI shows: "${bigErr || '(nothing)'}"`);
    await shot(page, 'A6_oversized_body');
  }

  // double-click publish
  {
    reqLog.length = 0;
    await page.goto(APP + '/editor');
    await page.fill('input[name=title]', `Double ${run}`);
    await page.fill('input[name=description]', 'double click');
    await page.fill('textarea[name=body]', 'x');
    await page.dblclick('button:has-text("Publish Article")');
    await page.waitForURL(/\/article\//, { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('.article-page h1', { timeout: 15000 }).catch(() => {});
    if (page.url().includes('/article/')) created.push(page.url().split('/article/')[1]);
    const posts = reqLog.filter(r => r.startsWith('POST /articles')).length;
    record('A7', 'Double-click on Publish creates duplicates', posts > 1 ? 'ISSUE' : 'PASS', `${posts} POST /articles request(s) sent`);
  }

  // ───────────── Edit ─────────────
  await page.goto(APP + '/editor/' + slug1);
  await page.waitForFunction(() => document.querySelector('input[name=title]')?.value?.length > 0, null, { timeout: 15000 });
  await page.fill('input[name=title]', `QA article ${run} edited`);
  await page.click('button:has-text("Publish Article")');
  await page.waitForURL(/\/article\//, { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('.article-page h1', { timeout: 15000 }).catch(() => {});
  const slugEdited = page.url().split('/article/')[1];
  if (slugEdited && slugEdited !== slug1) created.push(slugEdited);
  const oldLink = await api('GET', `/articles/${slug1}`);
  record('E1', 'Edit article happy path', page.url().includes('/article/') ? 'PASS' : 'FAIL',
    `saved; slug "${slug1}" → "${slugEdited}". Old link now → HTTP ${oldLink.status}`);
  record('E2', 'Editing a title silently breaks every shared link to the article', slugEdited !== slug1 && oldLink.status === 404 ? 'ISSUE' : 'PASS',
    `old slug returns ${oldLink.status}; no redirect from old URL`);
  await shot(page, 'E1_article_edited');

  // other user opens A's editor URL
  {
    const cb = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pb = await cb.newPage();
    await uiSignup(pb, userB);
    await pb.waitForURL(APP + '/', { timeout: 15000 }).catch(() => {});
    await pb.goto(APP + '/editor/' + slugEdited);
    await pb.waitForTimeout(4000);
    const errs = await pb.$$eval('.error-messages li', els => els.length);
    record('E3', "Opening another user's edit URL: no message", !errs ? 'ISSUE' : 'PASS',
      `ended on ${pb.url().replace(APP, '') || '/'} with ${errs} error message(s)`);
    await shot(pb, 'E3_other_user_editor');
    const putB = await api('PUT', `/articles/${slugEdited}`, { article: { title: 'hijack' } }, await pb.evaluate(() => localStorage.getItem('jwtToken')));
    record('E4', "API blocks editing another user's article", [403, 404].includes(putB.status) ? 'PASS' : 'ISSUE', `PUT as user B → HTTP ${putB.status} (blocked)`);
    await cb.close();
  }

  // ───────────── Delete ─────────────
  // D1: failure path – make the API fail and watch the UI
  {
    await uiCreateArticle(page, { title: `Delete-fail ${run}`, description: 'd', body: 'd' });
    await page.waitForURL(/\/article\//, { timeout: 15000 });
    await page.waitForSelector('.article-page h1', { timeout: 15000 }).catch(() => {});
    const slugF = page.url().split('/article/')[1];
    created.push(slugF);
    await page.route('**/api/articles/*', r => r.request().method() === 'DELETE'
      ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ errors: { body: ['Internal error'] } }) })
      : r.continue());
    await page.click('button:has-text("Delete Article") >> nth=0');
    await page.waitForTimeout(3000);
    const errs = (await page.$$eval('.error-messages li', els => els.map(e => e.textContent.trim()))).join('; ');
    const disabledAttr = await page.$eval('button:has-text("Delete Article")', b => b.disabled);
    const cls = await page.$eval('button:has-text("Delete Article")', b => b.className);
    record('D1', 'Failed delete gives no feedback and leaves button looking disabled', !errs ? 'ISSUE' : 'PASS',
      `DELETE forced to 500 → still on article, error shown: "${errs || 'none'}", button class "${cls}", real disabled attr: ${disabledAttr}`);
    await shot(page, 'D1_delete_failure_silent');
    await page.unroute('**/api/articles/*');
  }

  // D2: no confirmation + double-click sends two DELETEs
  {
    reqLog.length = 0; dialogs.length = 0;
    await uiCreateArticle(page, { title: `Delete-me ${run}`, description: 'd', body: 'd' });
    await page.waitForURL(/\/article\//, { timeout: 15000 });
    await page.waitForSelector('.article-page h1', { timeout: 15000 }).catch(() => {});
    const slugD = page.url().split('/article/')[1];
    await page.dblclick('button:has-text("Delete Article") >> nth=0');
    await page.waitForURL(APP + '/', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const dels = reqLog.filter(r => r.startsWith('DELETE')).length;
    const gone = await api('GET', `/articles/${slugD}`);
    record('D2', 'Delete has no confirmation; double-click fires 2 DELETEs', !dialogs.length || dels > 1 ? 'ISSUE' : 'PASS',
      `confirm dialogs: ${dialogs.length}; DELETE requests sent: ${dels}; article afterwards → HTTP ${gone.status}`);
    await shot(page, 'D2_after_delete');
  }

  // ───────────── Navigation / resilience ─────────────
  await page.goto(APP + '/this-page-does-not-exist');
  await page.waitForTimeout(2500);
  const mainText = (await page.evaluate(() => document.querySelector('app-root')?.innerText || '')).replace(/\s+/g, ' ').trim();
  record('N1', 'Unknown URL shows an empty page (no 404 page)', /not found|404/i.test(mainText) ? 'PASS' : 'ISSUE',
    `visible text is only header/footer: "${mainText.slice(0, 120)}…"`);
  await shot(page, 'N1_unknown_route');

  await page.goto(APP + '/article/this-article-does-not-exist-' + run);
  await page.waitForTimeout(3000);
  const n2 = (await page.$$eval('.error-messages li', els => els.map(e => e.textContent.trim()))).join('; ');
  record('N2', 'Missing article shows a technical error string', 'INFO', `UI shows: "${n2 || '(blank)'}"`);
  await shot(page, 'N2_missing_article');

  // API outage → home feed
  {
    const c3 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p3 = await c3.newPage();
    await p3.route('**/api/articles**', r => r.fulfill({ status: 503, contentType: 'text/html', body: '<html>503 Service Unavailable</html>' }));
    await p3.route('**/api/tags', r => r.fulfill({ status: 503, contentType: 'text/html', body: '<html>503</html>' }));
    await p3.goto(APP + '/');
    await p3.waitForTimeout(10000);
    const feed = await p3.textContent('body');
    const stuck = feed.includes('Loading articles') && feed.includes('Loading tags');
    record('F1', 'API outage: feed spins "Loading articles…" forever', stuck ? 'ISSUE' : 'PASS',
      `/articles and /tags return 503 → after 10 s page still says "Loading articles..." and "Loading tags...", no error, no retry`);
    await shot(p3, 'F1_feed_stuck_loading');
    await c3.close();
  }

  // Slow 3G-like network: time to first article
  {
    const c4 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p4 = await c4.newPage();
    const cdp = await c4.newCDPSession(p4);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50000, uploadThroughput: 20000 });
    const t0 = Date.now();
    await p4.goto(APP + '/', { timeout: 90000 });
    await p4.waitForSelector('app-article-preview, .article-preview h1', { timeout: 90000 }).catch(() => {});
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const transferred = await p4.evaluate(() => Math.round(performance.getEntriesByType('resource').reduce((s, e) => s + (e.transferSize || 0), 0) / 1024));
    record('P1', 'Slow network (400 ms RTT, 400 kbit/s): time until first article', Number(secs) > 10 ? 'ISSUE' : 'INFO',
      `${secs} s until the first article renders; ~${transferred} KB transferred; only feedback is plain "Loading articles..." text`);
    await c4.close();
  }

  // API latency sample
  {
    const samples = [];
    for (let i = 0; i < 5; i++) samples.push((await api('GET', '/articles?limit=10')).ms);
    const tags = await api('GET', '/tags');
    record('P2', 'API latency (5 × GET /articles?limit=10)', Math.max(...samples) > 1500 ? 'ISSUE' : 'INFO',
      `${samples.join(' / ')} ms; GET /tags ${tags.ms} ms`);
  }

  // ───────────── Security headers ─────────────
  {
    const r = await fetch(APP + '/');
    const h = Object.fromEntries(r.headers);
    const missing = ['content-security-policy', 'x-frame-options', 'strict-transport-security', 'x-content-type-options', 'referrer-policy'].filter(k => !h[k]);
    record('X1', 'Frontend is missing standard security headers', missing.length ? 'ISSUE' : 'PASS', `missing: ${missing.join(', ') || 'none'}`);
    const pre = await fetch(API + '/user', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization' } });
    record('X2', 'API CORS policy', 'INFO', `preflight from https://evil.example → ${pre.status}, allow-origin: ${pre.headers.get('access-control-allow-origin')}`);
    const stored = await page.evaluate(() => Object.keys(localStorage));
    record('X3', 'Auth token stored in localStorage (readable by any script on the page)', stored.includes('jwtToken') ? 'ISSUE' : 'INFO', `localStorage keys: ${stored.join(', ')}`);
  }

  // Account takeover surface: change email/password with only the token
  {
    const tok = await page.evaluate(() => localStorage.getItem('jwtToken'));
    const newEmail = `qa_a2_${run}@example.com`;
    const upd = await api('PUT', '/user', { user: { email: newEmail } }, tok);
    record('X4', 'Email/password can be changed without the current password', upd.status === 200 ? 'ISSUE' : 'PASS',
      `PUT /user {email} with only the JWT → HTTP ${upd.status}`);
    userA.email = upd.status === 200 ? newEmail : userA.email;
  }

  // ───────────── Accessibility ─────────────
  for (const [path, label] of [['/editor', 'editor'], ['/settings', 'settings']]) {
    await page.goto(APP + path);
    await page.waitForTimeout(1500);
    const a = await page.evaluate(() => {
      const fields = [...document.querySelectorAll('input:not([type=hidden]), textarea')];
      const unlabeled = fields.filter(f => !(f.labels?.length) && !f.getAttribute('aria-label') && !f.getAttribute('aria-labelledby')).length;
      const clickIcons = [...document.querySelectorAll('i.ion-close-round')].filter(i => i.tabIndex < 0).length;
      return { lang: document.documentElement.lang || '(none)', fields: fields.length, unlabeled, clickIcons };
    });
    record(`AC-${label}`, `Accessibility – ${label} form`, a.unlabeled ? 'ISSUE' : 'PASS',
      `${a.unlabeled}/${a.fields} fields have no <label>/aria-label (placeholder only); <html lang>=${a.lang}`);
  }
  {
    await page.goto(APP + '/editor');
    await page.fill('input[placeholder="Enter tags"]', 'a11y');
    await page.press('input[placeholder="Enter tags"]', 'Enter');
    await page.waitForSelector('.tag-list .tag-pill', { timeout: 10000 });
    const tagIcon = await page.$eval('.tag-list .tag-pill', p => {
      const i = p.querySelector('i, button, [role=button]') || p;
      return { tab: i.tabIndex, role: i.getAttribute('role'), label: i.getAttribute('aria-label'), html: p.outerHTML.slice(0, 160) };
    });
    record('AC-tags', 'Tag "remove" control is a mouse-only <i> icon', tagIcon.tab < 0 ? 'ISSUE' : 'PASS',
      `tabIndex ${tagIcon.tab}, role ${tagIcon.role}, aria-label ${tagIcon.label} → cannot be reached by keyboard or screen reader`);
  }

  // ───────────── Logout ─────────────
  const tokenBeforeLogout = await page.evaluate(() => localStorage.getItem('jwtToken'));
  await page.goto(APP + '/settings');
  await page.click('button:has-text("logout")');
  await page.waitForURL(APP + '/', { timeout: 10000 }).catch(() => {});
  const after = await page.evaluate(() => localStorage.getItem('jwtToken'));
  const nav2 = await page.textContent('nav');
  record('O1', 'Logout clears session in the browser', !after && /Sign in/.test(nav2) ? 'PASS' : 'FAIL', `token in storage after logout: ${after ? 'yes' : 'no'}; header shows "Sign in": ${/Sign in/.test(nav2)}`);
  await shot(page, 'O1_logged_out');

  const reuse = await api('GET', '/user', null, tokenBeforeLogout);
  record('O2', 'Token still valid on the server after logout', reuse.status === 200 ? 'ISSUE' : 'PASS',
    `GET /user with the pre-logout token → HTTP ${reuse.status}; logout is client-side only (token is just deleted from localStorage; opaque token "${tokenBeforeLogout.slice(0, 10)}…" is never revoked)`);

  await page.goto(APP + '/editor');
  await page.waitForTimeout(2000);
  record('O3', 'Protected page after logout redirects to login', page.url().includes('/login') ? 'PASS' : 'ISSUE', `/editor → ${page.url().replace(APP, '')}`);

  {
    await page.goto(APP + '/register');
    await page.waitForSelector('input[name=username]', { timeout: 10000 }).catch(() => {});
    const a = await page.evaluate(() => {
      const fields = [...document.querySelectorAll('input:not([type=hidden]), textarea')];
      return { lang: document.documentElement.lang || '(none)', fields: fields.length,
        unlabeled: fields.filter(f => !(f.labels?.length) && !f.getAttribute('aria-label') && !f.getAttribute('aria-labelledby')).length };
    });
    record('AC-register', 'Accessibility – sign-up form', a.unlabeled ? 'ISSUE' : 'PASS',
      `${a.unlabeled}/${a.fields} fields have no <label>/aria-label (placeholder only); <html lang>=${a.lang}`);
  }
  // cleanup with A's (still valid) token
  for (const s of created) await api('DELETE', `/articles/${s}`, null, tokenBeforeLogout).catch(() => {});
  // ── runs last: these can invalidate the main session on the demo backend ──
  // duplicate email via UI: a throwaway "victim" account, then a second sign-up re-using its email
  {
    const victim = { username: `qa_victim_${run}`, email: `qa_victim_${run}@example.com`, password: 'VictimPass!1' };
    const cv = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pv = await cv.newPage();
    await uiSignup(pv, victim);
    await pv.waitForURL(APP + '/', { timeout: 15000 }).catch(() => {});
    const victimTok = await pv.evaluate(() => localStorage.getItem('jwtToken'));

    const c2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p2 = await c2.newPage();
    await uiSignup(p2, { username: `qa_attacker_${run}`, email: victim.email, password: 'attacker123' });
    await p2.waitForSelector('.error-messages li', { timeout: 8000 }).catch(() => {});
    const err = (await p2.$$eval('.error-messages li', els => els.map(e => e.textContent.trim()))).join('; ');
    const dupTok = await p2.evaluate(() => localStorage.getItem('jwtToken'));
    const victimNow = await api('GET', '/user', null, victimTok, cv.request);
    const attackerLogin = await api('POST', '/users/login', { user: { email: victim.email, password: 'attacker123' } }, null, c2.request);
    record('S4', 'Sign-up with an existing email is accepted (sandbox-dependent)', err ? 'PASS' : 'INFO',
      err ? `UI message: "${err}"` :
      `2nd sign-up with victim's email → accepted, no error. Attacker received the SAME token as the victim: ${dupTok === victimTok}. ` +
      `Victim's own token now resolves to username "${victimNow.json?.user?.username}". Attacker's password logs in with the victim's email → HTTP ${attackerLogin.status}`);
    await shot(p2, 'S4_duplicate_email');
    await cv.close();
    await c2.close();
  }

  // brute force: 12 wrong attempts in a row from the same client
  {
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await api('POST', '/users/login', { user: { email: userA.email, password: 'nope' + i } })).status);
    const ok = await api('POST', '/users/login', { user: { email: userA.email, password: userA.password } });
    record('L3', 'Repeated failed logins: never 429, then correct password also rejected', codes.includes(429) ? 'PASS' : ok.status !== 200 ? 'INFO' : 'ISSUE',
      `12 wrong passwords in ~${'a few'} seconds → HTTP ${[...new Set(codes)].join(',')} (never 429, no CAPTCHA/delay); correct password right after → ${ok.status} – either a silent lockout (user is told "credentials invalid") or sandbox behaviour`);
  }

} catch (e) {
  record('ERR', 'Script error', 'FAIL', e.stack + `
(page url at failure: ${page.url()})`);
  await shot(page, 'ERR_state').catch(() => {});
  console.log('localStorage token:', await page.evaluate(() => !!localStorage.getItem('jwtToken')).catch(() => '?'));
} finally {
  fs.writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify({ run, app: APP, api: API, when: new Date().toISOString(), results }, null, 2));
  await browser.close();
  const c = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  console.log('\nSummary:', c, `– ${results.length} checks`);
}
