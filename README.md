# Automation & QA Developer – Assessment Submission (Naman Malhotra)

| Task | Deliverables |
|---|---|
| **1. Web app QA & debug report** | [`task1/Task1_QA_Report_NamanMalhotra.pdf`](task1/Task1_QA_Report_NamanMalhotra.pdf) · test script [`task1/qa-tests/qa.mjs`](task1/qa-tests/qa.mjs) · raw results [`results.json`](task1/qa-tests/results.json) · [`screenshots/`](task1/qa-tests/screenshots) |
| **2. n8n API integration workflow** | [`task2/Task2_Workflow_NamanMalhotra.json`](task2/Task2_Workflow_NamanMalhotra.json) · [`task2/README.md`](task2/README.md) · [`task2/screenshots/`](task2/screenshots) |
| **Bonus. Uptime monitor** | [`bonus/Bonus_UptimeMonitor_NamanMalhotra.json`](bonus/Bonus_UptimeMonitor_NamanMalhotra.json) · [`bonus/README.md`](bonus/README.md) · `bonus/*.png` |

**Walkthrough video:** [Watch the walkthrough](https://drive.google.com/file/d/1O0rNIDoOSC5jzWqPXhqEnI20w4aydoUk/view?usp=sharing)

## Summary of work

**Task 1: QA of RealWorld "Conduit".** The suggested `demo.realworld.io` is down (404, and its API returns 530). The project has moved to `realworld-apps`, and its official live demo is **demo.realworld.show** (Angular frontend plus a public sandbox API), so I tested that. I went through sign-up, login, create, edit, delete and logout by hand. Then I automated **38 checks with Playwright**, covering edge cases (empty, oversized and special-character input, XSS payloads, double-clicks), forced API failures (503, 500), a throttled network, session reuse after logout, security headers and accessibility. I confirmed each frontend bug by reading the Angular source. The report lists **15 issues** (5 High, 7 Medium, 3 Low). The main theme is that *error paths were never built*: the feed hangs on "Loading…" forever when the API fails, delete failures are silent, a missing article shows a blank page, and server errors claim "check your internet connection". The root-cause analysis covers the hanging feed. I noted sandbox-dependent results (for example, a duplicate-email sign-up) separately rather than over-claiming them.

**Task 2: "HN Morning Brief" in n8n.** Every hour (or `GET /webhook/hn-brief`) it pulls the Hacker News front page from the **Algolia API**, keeps the **top 5 by points**, enriches every story with **live score and comment counts from the official HN API**, and fetches the **top comment** on #1. An **IF** (#1 ≥ 500 points) chooses a "big story" header, and the digest is posted to **Discord**. Error handling: retries on every call. A front-page failure goes to a Discord alert. Enrichment failures degrade gracefully, so the brief still sends and is marked ⚠️. A failed Discord delivery fails the run visibly (Stop and Error). An **Error Trigger** catches anything else. Testing turned up an n8n gotcha: the Discord node's error output never fires, so I added an explicit "Delivered?" check. The only secret, the webhook URL, lives in the n8n credential store.

**Bonus: uptime monitor.** Every 5 minutes it checks the Task 1 frontend **and** its API. Each check makes 3 attempts and must return HTTP 200 **and** the expected content. It records response time per check and flags anything slower than 3 s. It alerts on DOWN, reminds every 30 min while a target stays down (no spam), and posts RECOVERED with the downtime. A daily 09:00 summary reports uptime %, average / p95 / max response time and incidents.

## Run it locally
```bash
npm i n8n && npx n8n start              # or: docker run -it --rm -p 5678:5678 n8nio/n8n
cp .env.example .env                    # add N8N_API_KEY + DISCORD_WEBHOOK_URL
node scripts/n8n-setup.mjs              # creates the credential, imports + activates both workflows
curl http://localhost:5678/webhook/hn-brief
```
Or import the two JSON files by hand (*Workflows → Import from File*), attach a **Discord Webhook** credential to the Discord nodes, and publish.

Task 1 checks: `cd task1/qa-tests && npm i && node qa.mjs` (uses the locally installed Chrome).

`scripts/build-workflows.mjs` generates both workflow JSON files from readable JavaScript. `scripts/mock-discord.mjs` is a local fake Discord, used for the forced-failure tests (`MOCK_FAIL=1`).
