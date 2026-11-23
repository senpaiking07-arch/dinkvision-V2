# Phase 6 usage assessment

Reviewed 2026-11-24 on `codex/r2-local-integration`. Phase 1–5 handoffs, the pending changes and current implementations were inspected. All forecasts use decimal GB, a 30-day month and one venue.

## Read-only observations

- One complete ListObjectsV2 response for the configured R2 bucket returned four Standard MP4 objects totaling **1,124,613,250 bytes**, averaging **281.15 MB**. This excludes unfinished multipart parts. It is a point-in-time inventory. The previously verified 15-minute clip alone was 790.82 MB. Four mixed-length files are insufficient to establish a representative bitrate.
- Supabase returned **86,400 seconds** for the venue retention setting and **14 recording sessions created in the preceding 24 hours**. Sessions include attempts and short recordings. PostgreSQL reported **15,218,355 bytes** for the current database. Daily growth, historical GB-month, paid usage, active deployment flags, account-wide quotas consumed and HTTP request counters were not measured.
- The optional migration emits only session creation and real status changes, with a five-second per-venue coalescing interval. One cursor row per venue bounds the application's extra persistent state. Session, upload and diagnostic rows still accumulate independently of cloud object expiry. The web uses one private channel per visible online tab. Android opens zero Realtime connections. This integration generates zero Postgres Changes subscriptions and zero Broadcast messages for multipart progress.

## Verified optimization

An active initial mount already has the authorized server snapshot. The previous hook fetched it again before joining and again after joining. The hook now arms the 30-second fallback immediately, connects, and reconciles on successful join. Resume or network recovery still reads immediately. A pending or rejected join leaves polling armed. Existing account and venue checks apply to each request.

The deterministic hook test recorded **2 → 1 snapshot GETs** from initial render through successful join, then **3 → 2** after one valid event, a duplicate and an older event. Both versions make one successful join in this sequence. This saves one Vercel snapshot invocation per qualifying initial activation. It also avoids three ordinary snapshot table reads (courts, settings, latest 100 sessions), typically a fourth private capture-report read, and sometimes a linked-session lookup. Auth, proxy and schema-fallback queries are additional. The test measures calls in a simulated browser. Network transfer, provider latency and production savings were not benchmarked.

Changes for this phase are `components/use-admin-realtime.ts`, `tests/admin-realtime.test.ts`, and this report. The Next.js production build and TypeScript stage passed. All 15 targeted admin Realtime, tenant isolation, R2 upload and queue tests passed.

## Monthly capacity forecast

Phase 2 assumptions: one enabled recorder per court, 5 recording hours/day, four 15-minute segments/hour, 150 MB/segment, seven days retained, timely cleanup. Model six emitted hints per segment (120/device/day) before any cross-device coalescing. Assume 1, 2 or 3 simultaneously visible admin tabs subscribed throughout the recording window. Android process and admin tabs are modeled active for five hours/day only. Headroom target is 70% of each applicable allowance.

| Estimate | 1 court | 4 courts | 10 courts |
|---|---:|---:|---:|
| Segments/month | 600 | 2,400 | 6,000 |
| Peak Realtime connections | 1 | 2 | 3 |
| Broadcast sends / delivered copies | 3,600 / 3,600 | 14,400 / 28,800 | 36,000 / 108,000 |
| Billable messages (send + copies) | 7,200 | 43,200 | 144,000 |
| Vercel requests mapped to function invocations | 265,400 | 1,014,400 | 2,510,400 |
| Illustrative Supabase egress GB | 1.08 | 3.96 | 10.39 |
| R2 monthly ingest GB | 90 | 360 | 900 |
| R2 steady-state GB-month | 21 | 84 | 210 |
| Standard storage excess GB-month | 11 | 74 | 200 |
| Storage-only estimated USD/month | 0.17 | 1.11 | 3.00 |
| Modeled R2 Class A / Class B operations | 7,800 / 4,200 | 31,200 / 16,800 | 78,000 / 42,000 |

**Realtime.** Emits = segments × 6. Deliveries = emits × visible subscribers. Supabase counts a Broadcast send plus each delivery. A serialized example envelope was 251 bytes before framing. Modeled use peaks at 7.2% of 2M monthly messages and 1.5% of 200 concurrent connections. Duplicated tabs and additional venues increase consumption. An always-busy venue at the five-second cap could send 518,400 times/month; three always-connected subscribers would bring the count to 2,073,600. [Supabase billing](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages) · [Plan allowances](https://supabase.com/pricing)

**Vercel.** In 9,000 active minutes/month, each enabled recorder can approach 24 tablet calls/minute (heartbeat POST plus state GET on a five-second fixed delay), plus one release check/minute. A slow cycle lowers the rate. Add a provisional ten control-plane calls per segment for reservation, queue and upload actions. Each visible overview tab contributes about 9,000 idle snapshots, 18,000 summary polls and 3,800 token/rejoin-snapshot calls, plus at most one snapshot per modeled delivered event. Formula: 231,000 × courts + 30,800 × tabs + deliveries. Timers reset on reads, so adding every poll and event is conservative for the dashboard. Retries, diagnostics, active-camera polling, queue contention, replay requests, cleanup and middleware billing can change totals substantially. A device online 24 hours/day can approach **1.08M** heartbeat/state/release requests monthly by itself. Server Components still handle initial loads, mutations and flag-off refreshes. Per-user snapshots are private and uncached. R2 serves video bytes directly. Hobby includes 1M function invocations, with separate CPU, memory and transfer quotas. Commercial venue deployments fall outside Hobby's personal/non-commercial use terms regardless of traffic. [Hobby limits](https://vercel.com/docs/plans/hobby) · [Fair use](https://vercel.com/docs/limits/fair-use-guidelines)

**Supabase egress and DB.** Budget placeholder of 40 KB Supabase-to-server output per dashboard snapshot, 2 KB aggregate per other modeled invocation (including auth and reads), and 251 bytes per delivered hint. Snapshots = 10,900 × tabs + deliveries. These sizes are assumptions, not response captures. Doubling average response size roughly doubles the estimate. Four courts exceed the 3.5 GB operating target and ten exceed the 5 GB free uncached egress allowance in this model. Treat cached egress separately. DB growth needs two or more size observations over time. Each modeled court creates 600 session rows/month before file, attempt, diagnostics, and index overhead. The 500 MB database limit has a 350 MB operating target. [Supabase pricing](https://supabase.com/pricing)

**R2.** Average retained GB = 20 × courts × 0.15 × 7. The Phase 2 table counted all monthly ingestion as retained for a whole month. At steady state seven-day retention consumes 7/30 of that amount. Storage pricing above assumes the full account-level 10 GB-month Standard allowance is available and $0.015/GB-month over it. Staying within 10 GB at the modeled volume requires 52%, 88%, or 95% less retained data, respectively. At the currently configured one day the same workload would average 3, 12, or 30 GB. Using the single observed full-length clip as a sensitivity case yields about **111 GB at one court for seven days**. Cleanup lag, orphaned uploads and other buckets raise cost. [R2 pricing and billing units](https://developers.cloudflare.com/r2/pricing/)

**Operations.** Example fresh attempt at 16 MiB/part: ceil(150,000,000 / 16,777,216) = 9 parts. Model 13 Class A operations per video (create, nine part PUTs, two ListParts, complete). ListParts is Class A. Model seven Class B operations per video (four HEADs including verification/cleanup and three ranged GETs for one illustrative replay). Actual batch grants, negotiated part sizes, retries, seeks and repeat downloads change these counts. Direct R2 internet egress is free; GET requests still count. Free monthly quotas are 1M Class A and 10M Class B. A report of playback attempts or byte ranges requires provider counters. [R2 operation classifications](https://developers.cloudflare.com/r2/pricing/)

## Monitoring and final integration review

Use existing dashboards and short staging captures. No telemetry ingestion service or raw event history was added.

| Where | What to collect | Review trigger or fallback |
|---|---|---|
| Supabase project Usage and Realtime Reports | Take weekly totals for peak channels/connections, messages, uncached egress and DB size. Compare day-over-day DB growth and project versus organization totals. | Review at 140 connections, 1.4M messages, 3.5 GB uncached egress or 350 MB DB. At quota pressure use flag-off polling after checking Vercel capacity. |
| One authorized staging browser | In DevTools count snapshot GETs, token POSTs, RSC calls, channel joins and incoming Broadcast frames during equal idle, busy, hidden and reconnect windows. Record aggregate transfer, count, duration and error percentage only. Compare to provider sends and active tabs for fan-out. | Hidden or offline tabs should release channels. Denial or timeout should leave fallback polling armed. Investigate sustained reconnects above three per minute per visible tab. |
| Vercel Usage and request logs | Compare 24h and projected month-end invocations, transfer, CPU, memory and per-route status counts. Separate tablet heartbeat/state, upload grants/status/finish, snapshot, RSC and replay. Compute 429/5xx percentage per route and count progress/status calls per completed video. | Review at 70% of any actual plan quota. On SDK/channel errors the web hook retries with jitter up to a 60-second cap. HTTP 401/403 closes the subscription and rechecks access. Snapshot failure shows stale data. |
| R2 bucket metrics and admin worker health | Track average daily storage and Class A/B totals, incomplete multipart usage, GET/HEAD counts, recorded sizes, and job last-success. Compare seven-day moving average to the 7 GB operating target and operation counts to 700k/7M. | Worker handles up to three expired files per venue/pass under a deadline, with identity checks, leases and retries. At 10 courts/200 expirations per day, budget at least 67 successful passes/day even with no contention. Verify actual scheduler cadence and age of oldest eligible file before rollout. |
| Device and storage workflow | During an authorized staging session interrupt connectivity after capture starts, then observe local finalization and later upload recovery. Capture the number of grants, reconciliations and PUTs per video from existing diagnostics. | Realtime quota cannot stop local capture. New matches need HTTP reservation. Upload retries retain local footage and finalize through the existing server checks. |

Final review should replace payload, uptime, transition and playback assumptions with one representative busy week of aggregate provider measurements. Verify commercial hosting eligibility and worker cadence before offering a venue a cost commitment.
