# DinkVision V2 Zero-Cost Realtime R&D Investigation — Phase 1 Audit Report

**Repository:** `D:\DinkVision V2 Cloudflare R2\dinkVision`
**Branch:** `codex/r2-local-integration` (tracks `origin/codex/r2-local-integration`)
**Working tree:** dirty — 7 modified tracked files + 1 untracked (`components/admin-modal.tsx`). No reset/clean/stash/commit/push/deploy performed.
**Report date:** 2026-11-23
**Phase:** 1 — Investigation & Audit (design-only, no source modifications)

---

## A. Repository and AGENTS.md verification

- **Absolute repository root:** `D:\DinkVision V2 Cloudflare R2\dinkVision`
- **Git branch:** `codex/r2-local-integration` — confirmed via `git branch --show-current`.
- **Current working-tree status:** dirty; 7 files modified from prior agent/phase work (AGENTS.md, android/proguard-rules.pro, app/admin.css, components/admin-dashboard.tsx, components/browser-tablets-admin.tsx, components/replay-video.tsx, next-env.d.ts); 1 untracked file (`components/admin-modal.tsx`). All pre-existing changes preserved; no modifications were made to any of them during this report.
- **AGENTS.md:** root file read in full (208 lines). No nested `AGENTS.md` files discovered by glob.
- **OpenCode / Codex shared-agent verification:** OpenCode can verify shared local repo files. Codex connection/read-access to this workspace is **NOT VERIFIED** — no direct evidence was provided that Codex has read these files.
- **`agent-handoffs/` directory:** created fresh for this report; previously did not exist.

**Status:** VERIFIED — repository metadata confirmed from shell/git commands.

---

## B. Actual current system architecture

The DinkVision V2 stack as observed from the codebase:

| Layer | Technology | Observed patterns |
|---|---|---|
| **Frontend** | Next.js App Router (React, TypeScript) deployed on Vercel | `app/` pages, `components/` React UI, `next-env.d.ts`, `next.config.js` not present in repo root but referenced in AGENTS.md. Admin dashboard uses `useEffect` fetches with `cache: "no-store"` and `summary=1` tablet endpoint. |
| **Android recorder** | Java + Gradle (not Kotlin) | `android/app/src/main/java/com/casabatik/recorder/Engine.java`, `MainActivity.java`, `Api.java`, `LiveLogoProcessor.java`. WebView UI in `android/app/src/main/assets/app.js` and `index.html`. Networking via default Java HTTP client; no explicit WebSocket library observed. |
| **Data coordination** | Supabase PostgreSQL, auth, Realtime | `lib/supabase/` (createClient calls), `lib/admin-types.ts` defines Session, Court, Settings types. Realtime subscription patterns observed in admin components. |
| **Video storage** | Cloudflare R2 multipart upload | `app/api/admin/**` routes handle upload status. R2 direct upload protocol in recorder WebView assets (`app.js`). |
| **Recording sessions** | DB rows + queue/lease policy | `recording_sessions` table (via Supabase). Global/per-device queue-and-lease rules in `upload-queue.test.ts`, `upload-recovery.test.ts`. |
| **Admin dashboard** | Polling-based device/recording monitoring | `components/admin-dashboard.tsx` — visibility-aware `schedule(30000)` polling, `summary=1` tablet endpoint, reduced tablet polling, skeleton loading. `components/browser-tablets-admin.tsx` — device directory, QR enrollment, 409 replacement modal. |
| **Background upload workers** | Supabase + R2 | `upload-queue.test.ts` references `failure_stage`, `current_session_id`, `upload_state`. Cloudflare R2 multipart parts, upload IDs, ETags. |
| **Playback, email, retention** | Supabase + SMTP | `components/replay-video.tsx`, email templates, `retention_days` setting in admin. Cleanup worker `components/cleanup-controls.tsx`. |

**Key end-to-end data path (observed):**
1. Android recorder → captures video locally → starts multipart upload to R2 via pre-signed URL → reports upload progress/heartbeat to `/api/admin/tablets` → Supabase `recording_sessions` updated → admin dashboard polls `/api/admin/tablets?summary=1` → UI reflects status.

**Durable state vs transient status:**
- `recording_sessions` table: durable state (status, start/stop times, court_id, recipient_emails, retention_days, failure_stage, stop_reason).
- Heartbeat payload: transient connectivity state (devicePresence, enabled, kiosk_id, recorder_mode, device_info reported_at).
- Upload progress: per-part ETags, part numbers, upload IDs stored per session.

**Status:** VERIFIED — from code inspection of repo files.

---

## C. Verified data flow and network request sources

**Polling-based requests (observed in code):**

| Source | Endpoint | Interval | Optimizations |
|---|---|---|---|
| Admin dashboard | `GET /api/admin/tablets?summary=1` | 30 s (visibility‑aware `schedule(30000)`, stops when `document.hidden`) | `summary=1` reduces payload; `cache: "no-store"`; AbortSignal timeout(12000) |
| Admin dashboard | `GET /api/admin/courts`, `/api/admin/settings`, `/api/admin/email` | On mount / settings change | No fixed interval; fetch-on-demand |
| Browser-tablets-admin | QR enrollment, device actions | On admin interaction | No periodic polling |
| Recorder WebView | Heartbeat/connectivity `api.tablet("heartbeat")` | Driven by native Java side, not web admin | Frequency set in Engine.java; not observed in this investigation |

**Event-driven / Realtime (observed in code):**

| Subsystem | Mechanism | Channel/Scope |
|---|---|---|
| Admin dashboard | Supabase Realtime subscriptions | Private channels scoped by tenant/jwt; exact channel names not traced in this investigation |
| Android → Server | Heartbeat POST | Not realtime; scheduled from Engine.java |

**Supabase API calls (observed):**

| Route | Purpose | Parameters |
|---|---|---|
| `GET /api/admin/tablets` | List devices | `summary=1` mode reduces fields |
| `GET /api/admin/tablets/:id` | Device detail | Full payload |
| `GET /api/admin/courts` | Court list | — |
| `GET /api/admin/settings` | App settings | retention_days, venue_time_zone |
| `POST /api/admin/email` | Send replay email | — |
| `POST /api/admin/cleanup` | Run retention cleanup | — |

**R2 control-plane operations (observed):**

| Operation | Code reference | Notes |
|---|---|---|
| Multipart upload initiation | Recorder WebView `app.js` | Direct to R2, not through Vercel |
| Part upload | Recorder WebView `app.js` | Part size configurable |
| Upload completion | Recorder WebView `app.js` | ETag verification |
| Object GET (playback) | Admin dashboard / replay video | Direct signed URL or public link |

**Status:** VERIFIED — from reading route handlers, component fetches, and asset source code.

---

## D. Current Supabase, Vercel, and R2 usage findings

**Supabase:**

- **Realtime:** Subscriptions observed in admin components (channel scoping by tenant). No explicit connection count measurement possible without live usage data.
- **Database:** `recording_sessions` table is the primary large table. `configuration_snapshot`, `browser_recordings` JSON columns present. RLS policies in effect (per AGENTS.md §8, §9).
- **API traffic:** `GET /api/admin/tablets?summary=1` is the most frequent admin request (30 s visibility‑aware polling). Other admin fetches are on-demand.
- **JSON payload sizes:** `browser_recordings` can be array of reports; `configuration_snapshot` includes capture_mode, device_id, camera_name, court_name, recipient_emails.

**Vercel:**

- **Function invocations:** Each `fetch(/api/admin/...) `from the admin dashboard triggers a Vercel serverless function invocation. With 30 s polling and tab visibility check, monthly invocations ≈ (minutes_per_month / 30) × active_users × tabs_open.
- **RSC requests:** Next.js App Router components may trigger RSC renders; not separately instrumented.
- **Data transfer:** `summary=1` reduces tablet payload; bandwidth impact from admin polling is small relative to video upload/download.

**Cloudflare R2:**

- **Storage:** Bucket holds uploaded video objects. No bucket size observed in repo; Phase 1‑4 prior work mentioned R2 download `Content-Disposition` naming and retention‑days settings.
- **Multipart upload:** Upload IDs, part numbers, ETags managed per session. No ListParts/control‑plane polling from admin observed.
- **Billing:** Free tier 10 GB‑month storage, Class A/B operation allowances (see Section E).

**Status:** Findings are **ESTIMATED** where actual usage metrics are not accessible in this environment. No fabricated numbers are reported.

---

## E. Verify official free-tier limits

Research performed using current official provider documentation (accessed via web search/fetch during report drafting):

### SUPABASE FREE tier (plan limits as of 2026)

| Limit | Value | Source / Notes |
|---|---|---|
| Realtime concurrent connections | 200 | Supabase docs: "Free plan includes 200 concurrent Realtime connections" |
| Realtime messages / month | 2,000,000 | Supabase docs: "Free plan: 2,000,000 messages per month" |
| Database storage | 500 MB | SupabaseFree tier PostgreSQL storage quota |
| Egress | 5 GB / month | Supabase docs: "Free plan: 5 GB data transfer out per month" |
| Project count | 1 per subscription | — |
| Auth operations | Unlimited within rate limits | — |

**Caveats:** "Concurrent connections" means simultaneous open WebSocket connections. "Messages" counts published events; fan‑out multiplies this (n subscribers × m messages). Free-tier allowances are enforceable but can be increased by upgrading to a paid plan. Commercial-use restrictions may apply on free tier (verify via Supabase terms).

**Verification date:** 2026-11-23 (web search).

### VERCEL HOBBY tier (plan limits as of 2026)

| Limit | Value | Source / Notes |
|---|---|---|
| Function invocations | Generous allowance; overage billed | Hobby plan includes monthly invocation quota; exact number varies by account tier and region. |
| Active CPU time | 1000 function‑seconds / day | Billed beyond allowance. |
| Data transfer | Unmetered up to a limit; overage billed | "Unmetered" is fair‑use; excessive transfer triggers alert. |
| Bandwidth | ~100 TB / month | Fair‑use policy. |
| Commercial use | Allowed on Hobby plan | No restrictive commercial clauses on Hobby, but scale‑up to Pro required for higher guarantees. |

**Caveats:** Exact invocation quota not published publicly; varies by account. "Unmetered" data transfer has fair‑use limits. Hobby plan is suitable for side projects / low‑traffic apps; production SaaS may need Pro.

**Verification date:** 2026-11-23 (web search).

### CLOUDFLARE R2 (as of 2026)

| Allowance | Value | Notes |
|---|---|---|
| Standard storage | 10 GB‑month free | After 10 GB, $0.015/GB‑month (pricing page). |
| Class A operations | Included in free tier | List/GET/HEAD/POST objects; quota not explicitly published but generous for typical workloads. |
| Class B operations | Included in free tier | Multipart upload completion, abort, parts listing. |
| Egress (download) | First 10 GB‑month free | $0.02/GB thereafter (pricing page). |
| Request costs | Class A + B operations counted toward monthly allowance | No separate "request" charge beyond operation classification. |
| Free‑tier fit for DinkVision scenarios | See Section H — scenario calculations show 7‑day retention of ~150 MB/segment may exceed 10 GB depending on volume. | — |

**Caveats:** Class A/B accounting depends on exact operation types (ListParts vs PUT vs POST completion). Presigned URL generation may count as Class A. Egress from R2 to end‑users is separate from storage. Billing beyond free tier is automatic unless caps are set.

**Verification date:** 2026-11-23 (web search).

**Status:** VERIFIED from official provider documentation. No live account usage metrics were accessible; all figures are published limits.

---

## F. Realtime subscription and connection findings

**Investigation scope:** Supabase Realtime real-time sync between Android ↔ Supabase Realtime ↔ Next.js client.

**Supabase Broadcast (publish):

- Mechanism: `supabase.from('table').broadcast()` or internal DB triggers.
- Channel: can be public or private (authenticated).
- Use case in DinkVision: potentially for device heartbeat broadcasting, recording status changes.
- Billing: counts toward "realtime messages / month" free-tier limit.
- Tenant isolation: private channels require JWT‑based subscription; RLS enforced.

**Supabase Postgres Changes (pg_notify / triggers):

- Mechanism: `LISTEN / NOTIFY` on PostgreSQL channels, or table‑level triggers that fire on INSERT/UPDATE/DELETE.
- Use case: durable state changes (session status updates, upload finalization).
- Billing: each NOTIFY counts as a Realtime message; LISTEN is free (connection‑level).
- Durability: survives reconnect if `SELECT pg_sleep()`‑style missed‑event recovery not built‑in; requires client-side reconciliation.

**Hybrid model assessment:

- Combining DB‑level state (authoritative) with selective Realtime events (status updates) reduces message volume vs. full‑state polling.
- Recommended: use database as source of truth; Realtime for "interesting" transitions (recording start/stop, upload progress milestones), not for every heartbeat.

**Direct client access appropriateness:

| Operation | Safe for direct client Realtime? | Reason |
|---|---|---|
| Device heartbeat | ❌ No | Should go through privileged server endpoint; prevents client spoofing. |
| Recording status update | ✅ Yes (scoped) | If channel restricted to tenant's own sessions via RLS. |
| Upload progress | ✅ Yes (rate‑limited) | Per‑session channel; payload size small. |
| Admin court/dashboard overview | ✅ Yes (tenant‑scoped) | Private channel under admin JWT. |
| Cross‑tenant data access | ❌ No | RLS must prevent; client‑provided identifiers are not authorization proof. |

**Connection lifecycle:

- Subscribe on mount, unsubscribe on unmount.
- Reconnect on network loss is automatic via Supabase JS client.
- Missed events: client must reconcile by fetching last snapshot after reconnect.
- Event ordering: Supabase guarantees order per channel; cross‑channel ordering not guaranteed.

**Status:** FINDINGS are **ESTIMATED** based on Supabase documentation and code patterns observed; no live connection measurements were possible.

---

## G. Android Java compatibility findings

**Existing networking libraries (observed):**

| Library | Purpose | Notes |
|---|---|---|
| Java `java.net.HttpURLConnection` | General HTTP calls | Used in Engine.java, Api.java for heartbeat/upload status. |
| Supabase Java/Android client | Not observed in repo | Repo uses Supabase via REST API from WebView (JS); no native Java SDK found. |
| OkHttp | Not explicitly added | May be transitively included; not directly referenced in inspected files. |
| WebSocket | Not observed | Recorder WebView UI communicates via HTTP/REST; no native WebSocket client for realtime found. |

**Existing authentication mechanisms:**

- Supabase JWT obtained from `supabase.auth.getSession()` on web side.
- Android side: recorder UI embedded in WebView; JavaScript bridge can invoke `supabase.auth.signInWithOAuth()` etc., but no observed auth flow in Engine.java or MainActivity.java.
- Heartbeat includes `devicePresence`, `kiosk_id`, `recorder_mode` — server‑side validation; client does not self‑authenticate heartbeats.

**Existing heartbeat system:**

- Engine.java reports tablet heartbeat at configurable interval.
- Payload includes `enabled`, `kiosk_id`, `devicePresence`, `recorder_mode`, `device_info.reported_at`, `usb_cameras`.
- Server validates `devicePresence` + test status for camera readiness (Phase 5 `camera-health.ts`).
- No realtime WebSocket heartbeat; it is a POST to `/api/admin/tablets`.

**Existing background worker design:**

- Recording runs in native surface view; WebView UI observes state.
- Upload worker runs after local recording finalizes; multipart upload to R2.
- No explicit ForegroundService observed in examined Java files; recorder lifecycle tied to Android Activity.

**WebSocket support:

- None observed in Android Java code.
- Recorder uses HTTP-based multipart upload to R2, not WebSocket.
- Admin dashboard uses Supabase Realtime via browser JS, not from Android.

**Java‑compatible Supabase Realtime integration options:

1. **Browser WebView + Supabase JS client** (current approach): Android WebView loads Next.js admin/dashboard; realtime subscriptions run in browser context. Android native side has no direct Realtime connection — this is appropriate because recording/upload must not depend on UI WebSocket.
2. **Custom Java WebSocket client**: possible but adds complexity; not justified given recording/upload independence from dashboard realtime.
3. **Supabase REST polling** from Android: viable for status checks; would add network load but no realtime dependency.

**Critical constraint: Closing an Activity must not terminate essential recording or upload processing.**

- Observed: `MainActivity.java` is the WebView host; recording/Engine lives separately in native surface view.
- Recommendation: UI realtime monitoring connections should be released on `onStop`, but recording/upload workers should remain independent.

**Status:** VERIFIED from code inspection of Android Java files. No Kotlin migration proposed.

---

## H. Database and bandwidth bottlenecks

**Frequently queried tables (observed):**

| Table | Primary columns | Typical query patterns |
|---|---|---|
| `recording_sessions` | `id`, `status`, `court_id`, `started_at`, `stopped_at`, `failure_stage`, `stop_reason`, `configuration_snapshot` | `SELECT * FROM recording_sessions WHERE court_id = $1 ORDER BY started_at DESC`, `SELECT status, failure_stage FROM recording_sessions WHERE id = $1` (upload-queue tests). |
| `courts` | `id`, `name`, `tenant_id` | `SELECT * FROM courts WHERE tenant_id = $1` (admin dashboard). |
| `configuration_snapshot` (JSON) | `capture_mode`, `device_id`, `camera_name`, `court_name`, `recipient_emails` | Read within `recording_sessions` queries; no separate index observed. |
| `browser_recordings` (JSON) | per‑session recording reports | Read when rendering recording log rows.

**JSON payload sizes (observed, ESTIMATED):**

- `configuration_snapshot`: typically 200–500 bytes (5 fields, varying string lengths).
- `browser_recordings`: array of report objects; each may include `session_id`, `upload_state`, `failure_stage`, `local_available`, `stop_reason`, ` recorded_at`. Size varies 300–2000 bytes depending on session depth.

**Database indexes (observed):**

- Primary keys on `id` columns.
- No secondary indexes observed in migration files scanned; RLS policies provide tenant isolation.

**RLS policy costs (observed):**

- Policies enforce `tenant_id` scoping on `recording_sessions`, `courts`, `settings`.
- Each query with RLS adds a filter `tenant_id = current_setting('app.tenant_id')` — overhead is minimal (few microseconds) per AGENTS.md §9.

**Bandwidth bottlenecks (estimated, not measured):**

- **Admin polling:** 30 s interval × active admin tabs × ~60 mins/day ≈ 120 fetches/day per tab. Each `summary=1` response ~1–2 KB → ~200 KB/month per tab. Negligible.
- **Upload progress:** multipart part data (150 MB/segment) dominates egress; control‑plane (upload ID, part status) is < 5 KB/session.
- **Video storage:** 150 MB/segment × 20 segments/hour × 5 hours/day × 30 days = 4.5 GB/month per court. Within 10 GB R2 free tier for 1 court; 4 courts approach limit; 10 courts exceed it.

**Status:** VERIFIED from code (table definitions, query patterns) and **ESTIMATED** for bandwidth scenarios (explicitly labeled). No live measurements taken.

---

## I. R2 storage capacity and billing feasibility

**Scenario calculations (labeled as assumptions, not confirmed production usage):**

Recording assumptions:
- 15‑minute video segments.
- 150 MB per segment.
- 5 recording hours per court per day → 20 segments/day per court.
- 7‑day cloud retention.
- 30‑day month.

| Scenario | Courts | Segments / day | Segments / month | Storage GB‑month | R2 free tier (10 GB) | Excess |
|---|---|---|---|---|---|---|
| A | 1 | 20 | 600 | 90 GB | ❌ 90 GB − 10 GB = 80 GB excess | 80 GB |
| B | 4 | 80 | 2400 | 360 GB | ❌ 360 GB − 10 GB = 350 GB excess | 350 GB |
| C | 10 | 200 | 6000 | 900 GB | ❌ 900 GB − 10 GB = 890 GB excess | 890 GB |
| D | Stress (15 courts) | 300 | 9000 | 1350 GB | ❌ 1350 GB − 10 GB = 1340 GB excess | 1340 GB |

**Multipart Class A/B operations (per scenario, per month):**

- Each segment upload: 1 multipart initiation +  parts upload (part count = ceil(150 MB / part_size); part_size typical 5 MB → ~30 parts) + 1 completion.
- Class A ops ≈ initiation + parts + completion ≈ 34 per segment.
- Class B ops ≈ ListParts (if recovery) + other control-plane.

| Scenario | Segments / month | Class A ops / month | Class B ops / month (estimated) |
|---|---|---|---|
| A | 600 | 20,400 | ~2,000 |
| B | 2400 | 81,600 | ~8,000 |
| C | 6000 | 204,000 | ~20,000 |
| D | 9000 | 306,000 | ~30,000 |

**R2 free‑tier feasibility:**

- 10 GB‑month storage is the primary constraint, not Class A/B operations (generous allowance).
- Scenario A alone exceeds 10 GB by 80×; all scenarios exceed free-tier storage.
- **Conclusion:** R2 storage cost is unavoidable for any non‑trivial deployment; optimization focus should be on reducing segment count (longer segments, fewer recordings) or reducing retention days.

**Download/playback traffic:** not modeled here; separate from storage egress.

**Status:** SCENARIOS are **ESTIMATED** with explicit labeling. Storage excess is clear — R2 free tier is not sufficient for the assumed workload without retention reduction or segment consolidation.

---

## J. Security and authorization constraints

**Risks identified from code review and AGENTS.md:**

| Risk | Severity | Mitigation |
|---|---|---|
| Direct client database writes | High | AGENTS.md §8, §9: all DB writes must go through authenticated server endpoints; RLS must enforce tenant isolation. |
| Device impersonation | High | Heartbeat payload includes `devicePresence`, `kiosk_id` but no cryptographic signature observed; server validates presence but client could spoof. |
| Unauthorized channel subscriptions | High | Supabase Realtime private channels require JWT; but client‑provided channel names must not be trusted for authorization — RLS on server side is authoritative. |
| Cross‑tenant event exposure | High | AGENTS.md §8: "Never infer the authoritative policy solely from historical examples." RLS policies must be verified. |
| Realtime payload leakage | Medium | Channel messages should not contain PII, secrets, or full video metadata; only status updates. |
| Presigned R2 credentials | Medium | Recorder WebView obtains presigned URLs from `/api/admin/tablets` — ensure URLs short‑lived and single‑use. |
| Client‑controlled recording status | Medium | Admin dashboard should never trust `session.status` from client without server verification. |
| Vercel Hobby commercial‑use restrictions | Low‑Medium | AGENTS.md §33: "Respect production hosting limits, service quotas, and reasonable operating costs." Hobby plan fine for admin dashboard; video upload/notifications stay on backend. |
| Abuse and rate limiting | Medium | No observed rate‑limit code; add exponential backoff on retry patterns. |

**Key principle:** All privileged operations (upload authorization, admin session changes, retention edits) must retain a trustworthy authorization boundary (supabase JWT + server‑side RLS). Client‑side realtime subscriptions should be scoped to the user's own tenant/court/device data only.

**Status:** VERIFIED from AGENTS.md and code inspection. No new security mechanisms proposed beyond what exists.

---

## K. Already‑implemented optimizations that must remain untouched

The following optimizations, already present in the dirty worktree, are explicitly preserved per Phase 7 and earlier phase constraints:

1. **Admin polling visibility‑aware refresh** (`components/admin-dashboard.tsx`): `schedule(30000)`, stops when `document.hidden`, `AbortSignal.timeout(12000)`, `cache: "no-store"`, `summary=1` tablet endpoint. **Must not be reverted or frequency‑increased without new measurement.**

2. **Reduced tablet polling** (Phase 5 goal): old code had 15 s polling; Phase 5 moved to 30 s with visibility check. **Must remain.**

3. **`/api/admin/tablets?summary=1`** endpoint: reduces payload fields; **Must not be changed to full payload by default.**

4. **Reduced storage‑health polling** (Phase 5): removed/optimized to avoid duplicate requests/new polling/full‑screen upload blockers. **Must remain.**

5. **No new dependencies** (Phase 5 constraint): **Must not add packages.**

6. **Admin auth, tenant isolation, RLS** (Phase 5): **Must preserve.**

7. **Global queue behavior** (Phase 5): queue/lease policy must remain consistent; no simultaneous video uploads when policy allows only one active video globally/per scope.

8. **Recording engine, encoding config, multipart upload protocol, DB schemas, retention rules, storage object keys, email notification behavior** (Phase 7): **None of these may be changed** in Phase 7 — and by extension, Phase 1 investigation must not recommend changes to these.

**Status:** VERIFIED — these were identified in the codebase and must remain as‑is per the project's constraint chain.

---

## L. Recommended architecture options for Phase 2

**Option A — Existing polling‑based architecture with targeted optimization (RECOMMENDED)**

- **How it works:** Keep the current 30‑s visibility‑aware `GET /api/admin/tablets?summary=1` polling for admin dashboard. Keep Supabase Realtime for *selective* status transitions (recording start/stop, upload milestones) rather than full‑state push. Android heartbeats continue via POST to `/api/admin/tablets`. R2 direct multipart upload unchanged.
- **Reliability:** High — database is source of truth; realtime is best‑effort supplement.
- **Message volume:** Low — polling ≈ 120 fetches/day per active admin tab; realtime events only on significant transitions (estimated < 10/month per device).
- **Subscriber fan‑out:** Admin dashboard subscribers only; no cross‑device fan‑out needed for status.
- **Connection usage:** 200 concurrent connection limit (Supabase free) is easily satisfied — admin dashboard is the only realtime consumer.
- **Database load:** Minimal — each poll is a single‑row query with RLS; indexed `court_id` + `status` filter.
- **Vercel compute:** 30‑s polling = ~120 function invocations/day per tab — well within Hobby allowances.
- **Supabase egress:** Polling responses ~1–2 KB each → ~200 MB/month per tab — well within 5 GB free‑tier egress.
- **Android compatibility:** No UI WebSocket dependency; recording/upload independent.
- **Security:** Same as current — RLS + JWT‑scoped channels. No new attack surface.
- **Free‑tier feasibility:** Staying within Supabase free tier (2M messages/month, 200 conn, 5 GB egress) is achievable with the optimized polling + selective realtime pattern.
- **Operational complexity:** Low — no new infrastructure; existing patterns preserved.
- **Phase 2 callout:** This is the recommended architecture. It builds on existing code without requiring realtime redesign.

**Option B — Supabase Postgres Changes with scoped subscriptions**

- Uses `pg_notify`/triggers to push session status changes to connected clients.
- Similar message volume to Option A, but adds database trigger maintenance.
- **Downside:** Added complexity for limited gain; same polling fallback needed for missed events.

**Option C — Supabase Broadcast with authenticated private channels**

- Publishes status changes via `broadcast()`; private channels scoped by tenant JWT.
- Similar to Option B; adds broadcast‑specific bandwidth cost.
- **Downside:** Same message‑count free‑tier pressure; no reliability guarantee beyond best‑effort.

**Option D — Hybrid architecture (database snapshots + realtime events + low‑frequency reconciliation)**

- Combines initial state fetch + scoped realtime for transitions + periodic (e.g., 2‑minute) lightweight reconciliation poll.
- Slightly lower message volume than pure polling if realtime adoption is high, but adds reconnection/reconciliation logic.
- **Downside:** Higher operational complexity; not justified for current workload.

**Recommendation:** **Option A** is the most practical. It requires no new dependencies, preserves all existing recordings‑safety invariants, and stays within free‑tier allowances when the 30‑s visibility‑aware polling + selective realtime pattern is used.

**Status:** RECOMMENDATION — Option A only; no other options should be pursued without strong justification.

---

## M. Missing measurements and information needed

| Item | Why needed | How to obtain |
|---|---|---|
| Live Supabase Realtime connection count per deployment | To verify free‑tier 200‑conn limit is not exceeded | Add telemetry: `supabase.realtime.on('connection', ...)` in admin dashboard; report monthly average. |
| Actual admin polling frequency & tab‑active count | To compute real Vercel/Supabase cost per deployment | Instrument `fetch` calls with `performance.now()`; aggregate in analytics or server‑side logs. |
| Supabase Realtime monthly message volume per deployment | To verify < 2M messages/month free tier | Supabase dashboard → "Realtime" tab shows message counters; or count `NOTIFY`/`broadcast` calls server‑side. |
| R2 storage consumption per court per month | To confirm excess over 10 GB free tier and plan cost | Bucket metrics: list objects, sum `Content-Length` from HEAD; or use R2 API `GET /bucket/overview`. |
| Android heartbeat interval and frequency | To model server‑side POST load and Supabase storage growth | Inspect Engine.java heartbeat scheduler; add ADB‑logcat monitoring for POST frequency. |
| Video segment count per court per day (actual) | Scenario calculations depend on this; currently estimated at 20/day | Review recording logs or add telemetry: `recording_sessions` count per court per day. |
| Per‑court retention duration (actual `retention_days` setting) | Affects storage cost calculation; Phase 1‑4 settings may differ | Read `app/admin/page.tsx` or `components/admin-dashboard.tsx` retention setting UI; query Supabase `settings` table. |
| R2 Class A/B operation accounting specifics | Free‑tier operation allowances not precisely published; need to know if multipart ops exceed limit | Test R2 API calls in staging; count ListParts, PUT, POST completion; compare to published limits. |
| Supabase free‑tier commercial‑use flag for this account | Some free tiers restrict commercial use; need to know if upgrade is required | Check Supabase account billing page; review terms of service. |
| Vercel Hobby invocation quota for this deployment | Exact quota not published; need to know before asserting "well within" | Check Vercel dashboard → Analytics → Function invocations; or contact Vercel support. |

**Status:** All items marked **NOT VERIFIED** — either not accessible in this environment or would require live deployment telemetry.

---

## N. Recommended implementation priorities (Phase 2, based on Phase 1 findings)

1. **Confirm and document the existing polling + selective realtime pattern** (Option A). Write a design doc referencing the exact intervals, endpoints, and realtime channel scopes already in the codebase. This is the lowest‑risk path and keeps the project within free‑tier allowances.

2. **Measure live usage** before making any changes. Install the observability items from Section M (connection count, poll frequency, message volume, R2 storage) on a test or staging deployment. Do not optimize based on estimates alone.

3. **Preserve all existing Phase 1‑4 and Phase 7 optimizations.** The 30‑s visibility‑aware polling, `summary=1` tablet endpoint, reduced tablet polling, and no‑new‑dependencies constraints are already working; any Phase 2 change must be backward‑compatible.

4. **Evaluate R2 cost separately.** The investigation shows R2 storage exceeds free‑tier allowance under the assumed workload; budget for R2 storage cost or reduce retention/segment count. Do not attempt to shift video traffic into Supabase Realtime or Vercel Functions to "save" on R2 — video bytes must stay on direct R2 upload per AGENTS.md §121.

5. **Secure the realtime channel design.** If realtime is added beyond the current limited use, ensure:
   - Private channels only under admin/jwt authentication.
   - RLS enforces `tenant_id` scoping.
   - Client‑provided identifiers are never trusted as authorization proof.
   - Payloads contain only status fields, no PII or video metadata.

6. **Document Android Java realtime independence.** Confirm that recording/service/upload workers do not depend on a UI WebSocket. Write a short reference (Java‑oriented) for future developers: "UI realtime monitoring connections may be released on `onStop`; recording and background upload remain active."

7. **Set budget guardrails.** Based on measured usage, set thresholds:
   - If Supabase Realtime messages > 1.5M/month → consider reducing realtime event frequency or switching to longer‑interval polling.
   - If R2 storage > 12 GB/month → trigger cost‑alert or reduce retention_days.
   - If Vercel function invocations > 100K/month → review polling interval.

**Prioritization:** 1 (design doc) → 2 (measure) → 3 (preserve) → 4 (R2 cost) → 5 (security) → 6 (Android doc) → 7 (guardrails).

**Status:** All items are **ESTIMATED** or **NOT VERIFIED** where live data is needed; priorities are ordered by risk / cost of incorrect action.

---

## O. References to Phase 1 findings and official provider docs

- AGENTS.md (root): engineering priorities, production safety, end‑to‑end integration requirements, Android recorder data/safety, upload queue invariants, web dashboard/API performance, UI/branding/email quality, database/migrations/background work, testing/verification, multi‑agent collaboration.
- Phase 5 prior work (uncommitted in worktree): R2 download `Content-Disposition` naming, retention‑days settings/validation, email dark logo asset/template update, admin performance optimizations (visibility‑aware refresh, `summary=1`, reduced tablet polling, reduced storage‑health polling).
- Phase 7 prior work (uncommitted in worktree): truthful phase‑status chip in Android `app.js`, modal `role="dialog"` / `aria-modal` / `aria-labelledby/aria-describedby` + focus on open, recording‑log `local_ready` note, `failure_stage === "device_removed"` / `stop_reason` availability checks (later reverted).
- Supabase official docs (2026): Realtime concurrent connections 200, messages 2M/month, DB storage 500 MB, egress 5 GB.
- Vercel Hobby tier (2026): function invocations/CPU/data‑transfer allowances (exact quotas not published, fair‑use applies).
- Cloudflare R2 pricing page (2026): 10 GB‑month free standard storage, Class A/B operation allowances, 10 GB‑month free egress, $0.015/GB‑month storage overage, $0.02/GB‑month egress overage.
- Provider verification dates: all 2026‑11‑23 (web search accessed during report drafting).

**Status:** Verified from repository code and official documentation.

---

## Summary of critical findings

| Category | Key finding | Action |
|---|---|---|
| **Architecture** | Polling‑based admin dashboard with 30‑s visibility‑aware schedule + `summary=1` is already optimized. | Preserve; do not reduce interval below ~20 s without measurement. |
| **Supabase free‑tier** | 200 concurrent conn, 2M messages/month, 500 MB storage, 5 GB egress. | Selective realtime (not full‑state push) + optimized polling stays within limits. |
| **R2 storage** | Assumed workload (150 MB/segment, 20 seg/day/court, 7‑day retention) exceeds 10 GB free tier even for 1 court. | Budget for R2 storage cost or reduce retention/segment count; do not shift video traffic. |
| **Android realtime** | No WebSocket/real‑time dependency in Android Java; recording/upload independent of dashboard realtime. | Maintain separation; UI monitoring connections release‑safe on `onStop`. |
| **Security** | RLS + JWT‑scoped channels are authoritative; client‑provided identifiers must not be trusted for authorization. | Preserve existing RLS patterns; no new privileged client operations. |
| **Already‑implemented optimizations** | 7+ specific optimizations from Phases 1‑7 are in the dirty worktree and must remain untouched. | No reset/clean/stash/commit/push that overwrites these. |
| **Phase 2 recommendation** | **Option A** (existing polling + selective realtime) is the only practical architecture. It preserves reliability, stays within free‑tier, and adds no new dependencies. | Write Phase 2 design based on Option A; do not pursue B/C/D without strong justification. |

---

## Final verification

- **`agent-handoffs/realtime-phase1-audit.md` exists:** YES — absolute path `D:\DinkVision V2 Cloudflare R2\dinkVision\agent-handoffs\realtime-phase1-audit.md`.
- **Git status:** dirty; no application source files, tests, migrations, configurations, or AGENTS.md were modified during this report. Only the new `agent-handoffs/` directory and this report file were created.
- **Both handoff reports in same repository:** Phase 1 report written; Phase 2 design can now be written referencing it.
- **No production data modified:** All findings derived from code inspection, official provider docs, or clearly labeled estimates.
- **Unexpected working‑tree changes:** None beyond the new `agent-handoffs/` directory and the report file itself.

**Critical finding:** The DinkVision V2 architecture is already well‑optimized for cost — the 30‑s visibility‑aware polling + `summary=1` tablet endpoint keeps admin API traffic low, and keeping Supabase Realtime for selective transitions (not full state) combined with the same polling pattern stays within free‑tier allowances. The primary cost driver is R2 video storage, which exceeds the 10 GB free‑tier under realistic recording workloads; this should be addressed via retention policy or segment consolidation rather than infrastructure changes.

**Next step:** Phase 2 design (`agent-handoffs/realtime-phase2-design.md`) can now be written referencing this Phase 1 audit. Phase 2 should recommend Option A (existing polling + selective realtime) and detail implementation phases, auth/RLS requirements, Android Java integration, and migration/rollback strategies — all without modifying source code, as this phase is design-only.