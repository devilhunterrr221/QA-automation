# Bonus – Uptime monitor for the Task 1 app

Watches **both halves** of the app tested in Task 1 every 5 minutes, and alerts the same Discord channel as Task 2.

| Target | URL | "Healthy" means |
|---|---|---|
| Conduit frontend | `https://demo.realworld.show/` | HTTP 200 **and** the HTML contains `Conduit` |
| Conduit API | `https://api.realworld.show/api/tags` | HTTP 200 **and** the body contains `"tags"` |

The content check catches a "200 that isn't the app", such as a parked domain, a CDN error page or an empty nginx default. A status code alone misses those. The checks use `GET` because the API answers `HEAD` with 405.

```
Every 5 Minutes / GET /webhook/uptime-check[?probe=<url>]
  → Targets → Loop Targets ─(one at a time)→ Start Timer → Ping (HTTP, 3 tries) → Evaluate Check ─┐
                          └─(done)→ Update History & Decide → Anything to report? → Post Uptime Alert → Delivered?
Daily 09:00 / GET /webhook/uptime-summary → Build Daily Summary → Post Daily Summary
```

## What makes it more than a ping
- **Retry logic:** `Ping` makes 3 attempts 5 s apart with a 10 s timeout, so one dropped packet doesn't page anyone. After the last attempt it *continues*, and the failure becomes a check result instead of a crashed run.
- **Response time:** `Start Timer` stamps each target just before its request, inside the loop, so the times don't add up across targets. The measured time includes retries, meaning "how long until we got a usable answer". Anything up but over **3 s** is flagged 🟡 slow.
- **No alert spam:** state per target lives in workflow static data. A target that goes **DOWN** alerts once immediately, then sends a **reminder every 30 min** while it stays down (not every 5 min). Coming back up sends 🟢 **recovered after N min**.
- **Daily summary (09:00):** uptime %, number of checks and failed checks, average / p95 / max response time, and incidents, computed from 24 h of stored history.
- **Delivery check:** the same **Delivered?** guard as Task 2. If Discord can't be reached, the execution fails visibly instead of finishing green.

## Test it
```bash
curl "http://localhost:5678/webhook/uptime-check"                                                    # normal check
curl "http://localhost:5678/webhook/uptime-check?probe=https://api.realworld.show/api/articles/nope"  # adds a target that 404s → 🔴 alert
curl "http://localhost:5678/webhook/uptime-summary"                                                  # daily summary now
```
Static data persists only for production executions (an active workflow, triggered by its schedule or webhook), not for manual "Execute workflow" runs in the editor.
