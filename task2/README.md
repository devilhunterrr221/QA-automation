# Task 2 – Hacker News "Morning Brief" (n8n)

Every hour (or on demand with `curl http://localhost:5678/webhook/hn-brief`), the workflow takes the Hacker News front page, keeps the **top 5 stories**, enriches them with **live data from the official HN API**, and posts a digest to **Discord**.

```
Every Hour / GET /webhook/hn-brief
  → HN Front Page (Algolia) ──error──→ Format Fetch Alert → Post Fetch Alert
  → Top 5 by Points (Code) → Live Stats (HN API, once per story) → Merge Live Stats (Code)
  → IF #1 ≥ 500 points ─true─→ Breakout Header ─┐
                       └false→ Regular Header ──┴→ Top Comment (HN API) → Compose Digest → Post Digest (Discord)
  → Delivered? ─no─→ Log Delivery Failure → Stop and Error
On Workflow Error (Error Trigger) → Format Crash Alert → Post Crash Alert
```

## APIs and why
| API | Used for | Why |
|---|---|---|
| **HN Algolia Search** `hn.algolia.com/api/v1/search?tags=front_page` | the 30 stories on the front page, in one call | Free, no key, and returns points, comment count and age together. The official API would need 31 calls to get the same list. |
| **Official HN API** (Firebase) `hacker-news.firebaseio.com/v0/item/{id}.json` | 1) live score and comment count for each of the 5 stories; 2) the top-ranked comment on #1 | A *second, independent* provider. Algolia's index lags by a few minutes, so this gives fresher numbers. `kids[]` is returned in rank order, so `kids[0]` is the best comment. |
| **Discord webhook** | the digest and the alerts | Free and instant, with no bot to set up. |

A tech team's morning brief is "what is everyone talking about today", and HN is that signal for developers. Both HN APIs are public and keyless, so the only secret in the whole workflow is the Discord webhook URL.

## Transformation
- **Top 5 by Points** (Code): drops non-stories, sorts by points, keeps 5, and reshapes each into `rank, id, title, url, hnLink, domain, author, points, comments, ageHours`. A front page with 0 stories is treated as an upstream failure, so the node throws and the Error Trigger fires.
- **Merge Live Stats** (Code): pairs each story with its live record and overwrites points and comments. It computes **points per hour** (how fast a story is climbing), re-ranks, and counts enrichment failures.
- **IF #1 ≥ 500 points:** the front page's top story usually has a few hundred points, so ≥ 500 means a genuinely big story. The threshold lives in one place, so it's easy to tune. Those runs get a 🚨 "Big story" header. Each story in the list also gets 🔥 at ≥ 300 points (roughly the top quarter of the front page).
- **Compose Digest** (Code): decodes the HTML in the comment, trims it to 280 characters, builds masked links (`<url>` stops Discord from adding 5 link previews) and caps the message at Discord's 2,000-character limit.

## Error handling (each path tested with forced failures, see `screenshots/`)
| Failure | What happens |
|---|---|
| Front-page API down (rate limit, 5xx, timeout 10 s) | 3 tries 2 s apart, then the **error output** goes to a ⚠️ Discord alert with the HTTP status and message, and logs to `console.error`. |
| Live stats or top comment fails | The node is set to *continue*, so the **digest still goes out** with Algolia's values and a "⚠️ live stats unavailable for N/5" line or "top comment unavailable". Enrichment is optional and shouldn't cancel the brief. |
| Discord rejects or is unreachable | 3 tries 3 s apart, then **Delivered?** sends it to *Log Delivery Failure* → **Stop and Error**. The execution goes red, and the Error Trigger tries a crash alert. |
| Anything unexpected (a Code node throws, etc.) | **Error Trigger**. The workflow is set as its own *Error Workflow* and posts 🛑 with the node name, the error and a link to the execution. |

**Gotcha found while testing:** with "continue on error", n8n's Discord node catches its own failure and emits `{error}` on its **success** output. Its error output never fires, so a Discord outage looked like a successful run. The explicit **Delivered?** check fixes that.

Try the failure paths from the manual webhook (the schedule never sets this flag):
`?simulate=fetch_fail` (front-page 404 → alert) · `?simulate=enrich_fail` (digest with the ⚠️ degraded line).

## Credentials
The Discord node uses an n8n **Discord Webhook** credential. The exported JSON contains only the credential's name and id, never the URL. `scripts/n8n-setup.mjs` creates the credential from a gitignored `.env`, imports the workflow and activates it.
