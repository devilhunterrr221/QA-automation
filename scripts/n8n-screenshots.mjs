// Captures the n8n screenshots for the submission (canvas + executions) with the local Chrome.
//   N8N_EMAIL=... N8N_PASSWORD=... node scripts/n8n-screenshots.mjs <task2ExecId> <task2FailExecId> <bonusExecId>
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(new URL('../task1/qa-tests/package.json', import.meta.url));
const { chromium } = require('playwright-core');

const N8N = 'http://localhost:5678';
const ids = JSON.parse(fs.readFileSync(new URL('../n8n-ids.local.json', import.meta.url), 'utf8'));
const T2 = ids['task2/Task2_Workflow_NamanMalhotra.json'];
const BONUS = ids['bonus/Bonus_UptimeMonitor_NamanMalhotra.json'];
const [okExec, failExec, bonusExec, bonusAlertExec] = process.argv.slice(2);
const out = p => new URL('../' + p, import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

const b = await chromium.launch({ channel: 'chrome', headless: true });
const page = await b.newPage({ viewport: { width: 1720, height: 900 }, deviceScaleFactor: 1 });
await page.goto(N8N + '/signin');
await page.fill('input[type=email], input[name=emailOrLdapLoginId], input[name=email]', process.env.N8N_EMAIL);
await page.fill('input[type=password]', process.env.N8N_PASSWORD);
await page.keyboard.press('Enter');
await page.waitForURL(u => !u.pathname.includes('signin'), { timeout: 20000 });

async function settle() {
  await page.waitForTimeout(2500);
  await page.getByText('Ignore for all workflows').first().click({ timeout: 1500 }).catch(() => {}); // "Production Checklist" pop-up
  await page.locator('button:has-text("Ignore for all workflows")').click({ timeout: 1500 }).catch(() => {}); // its confirm dialog
  for (const sel of ['button:has-text("Got it")', 'button:has-text("Dismiss")', '[data-test-id="notification-close"]', 'button[aria-label="Close"]']) {
    for (const el of await page.$$(sel)) await el.click().catch(() => {});
  }
  await page.keyboard.press('Shift+1').catch(() => {}); // zoom to fit
  await page.waitForTimeout(1200);
}
async function canvas(wf, file) {
  await page.goto(`${N8N}/workflow/${wf}`);
  await settle();
  await page.screenshot({ path: out(file) });
  console.log('saved', file);
}
async function execution(wf, exec, file, node) {
  await page.goto(`${N8N}/workflow/${wf}/executions/${exec}`);
  await settle();
  if (node) {
    const frame = page.frames().find(f => f.url().includes('/demo')) ?? page.mainFrame();
    await frame.locator(`[data-test-id="canvas-node"][data-node-name="${node}"], [data-name="${node}"]`).first().dblclick({ timeout: 8000 }).catch(e => console.log('open node failed', node, e.message.split('\n')[0]));
    await page.waitForTimeout(2000);
  }
  await page.screenshot({ path: out(file) });
  console.log('saved', file);
}

fs.mkdirSync(out('task2/screenshots'), { recursive: true });
await canvas(T2, 'task2/screenshots/a_canvas.png');
if (okExec) await execution(T2, okExec, 'task2/screenshots/b_execution_success.png');
if (okExec) await execution(T2, okExec, 'task2/screenshots/c_digest_output.png', 'Compose Digest');
if (failExec) await execution(T2, failExec, 'task2/screenshots/d_error_path_fetch_fail.png');
await canvas(BONUS, 'bonus/bonus_canvas.png');
if (bonusExec) await execution(BONUS, bonusExec, 'bonus/bonus_execution_healthy.png', 'Update History & Decide');
if (bonusAlertExec) await execution(BONUS, bonusAlertExec, 'bonus/bonus_execution_alert.png', 'Update History & Decide');
await b.close();
