# DinkVision Realtime final validation

**PASS WITH WARNINGS for isolated staging. Hold production rollout.** Reviewed November 24, 2026 on `codex/r2-local-integration`, including the uncommitted implementation and all six prior handoffs. The production gate is hosted authorization, credential rotation, device recovery evidence and a commercially eligible hosting plan.

## Integration and security

The recorder authenticates to the Next.js tablet API with its enrollment cookie. The backend resolves the device and venue and updates Supabase. Database triggers on recording creation and status changes emit private, versioned Broadcast hints. Each visible, online admin tab can join one tenant channel. The tab reloads an authorized snapshot after a hint. Android opens zero Realtime channels. Transfer progress, camera diagnostics and other changes without a recording transition depend on their existing reads or the next reconciliation.

The initial admin page and snapshot use the selected venue. The endpoint checks the current account, administrator role and requested tenant. Its same-origin token POST also checks the session user. Responses are private and uncached. The browser receives a **user access JWT** with the user's ordinary Supabase permissions. Keep the JWT out of logs and persistent client storage. Browser script access and the full set of deployed RLS policies matter. The privileged capture-report lookup uses only session IDs obtained from the scoped read.

In the optional migration, exact-topic SELECT policies require a confirmed user with active venue admin authority. Restrictive policies fence the namespace against permissive client write grants. The producer uses a private schema, a fixed search path and a private Broadcast. The payload contains IDs, time and revision. The local SQL suite exercised the real application policies against simulated auth and message transport. Hosted channel authorization, deployed grants and exposed RPCs still require verification. Supabase caches channel authorization. Measure revocation on an already joined client, including one that does not voluntarily rejoin. [Supabase Realtime authorization](https://supabase.com/docs/guides/realtime/authorization)

**Credential exposure is a production blocker.** Server, database, storage, mail, cron and application cryptographic credentials were pasted in the project conversation. Rotation status is unknown. Verify revocation/replacement with each issuer and update dependent services. Coordinate encryption-key rotation with recovery of existing encrypted records and signing-key rotation with outstanding replay links. Review access logs for the exposure period. This review performed no credential operations.

## State, recording and recovery

- Broadcast is best-effort. The producer coalesces within five seconds per venue and can skip a hint on contention or failure. Duplicate, older, malformed and foreign hints are filtered. One snapshot read runs at a time, and a hint during a read schedules another. The joined safety poll runs after 60 seconds of quiet, and disconnected polling runs after 30 seconds. Abort and socket-identity checks isolate obsolete callbacks. Snapshot errors mark displayed data stale. Loss of authorization hides the data and requests an access recheck. An Auth or membership-service outage can also appear as loss of access because the shared account resolver can return a null account on dependency errors. Recovery may require revisiting the admin page after service restoration.
- Phase 7 found that failed joins could retry indefinitely and brief successful joins could repeatedly reset backoff. The hook now allows five jittered retries per failure streak, then continues polling. A stable join of at least a minute restores the retry budget on disconnect or renewal. Returning to the foreground or recovering connectivity starts a fresh activation. Automated flapping-channel coverage verifies the sixth failure leaves only the fallback poll. This bounds socket attempts within an activation. Periodic HTTP reconciliation remains intentional.
- New recording authorization requires HTTP. Once capture starts, local encoding, finalization and journaling run independently of dashboard availability. Activity visibility and foreground services have separate ownership. Reboot interrupts capture. Local queue recovery runs when the engine initializes. Multiple queued recordings retain the existing global lease rules. A private channel event cannot start capture, grant an upload lease, declare upload success or delete footage.
- Authenticated APIs still authorize an attempt and sign its multipart grants. Bytes go directly to R2. Completion reconciles the object identity and metadata before committing the terminal state. Retry and local cleanup follow existing ownership and verified-completion rules. Replay checks signed access and cloud expiry. Delivery and retention run through backend jobs. No live upload, email delivery, expiry or deletion was exercised in Phase 7.

## Verification matrix

| Area | Verification and remaining evidence |
|---|---|
| Subscription, publication, tenant and device isolation | PGlite ran migrations, policies and the producer. Endpoint harness checked wrong origin, account, tenant, role and disabled flag. Managed WebSocket join, publish denial, public/private channel separation and expiry remain staging gates. |
| Initial state, duplicate/stale hints, outage, reconnect, polling and cleanup | Hook simulation exercised initial read behavior, validated hints, flapping joins, polling after exhaustion, offline/visible transitions, access loss, abort and teardown. Two simultaneous real browsers and a hosted Auth outage remain untested. |
| Multiple devices, recording/upload transitions, queue and replay | Node and local database suites exercised tenant isolation, competing claims, retry, verified multipart completion, replay and expiration paths. Real concurrent capture on two devices with two admin tabs remains pending. |
| Android backgrounding, capture, uploads and restart | Gradle debug assembly, lint and instrumentation Java compilation succeeded. JVM unit task reported NO-SOURCE. Device instrumentation was not run. ADB listed a connected device, without an isolated staging installation verified for these tests. Debug APK metadata reports 0.5.52, versionCode 58, at `android/app/build/outputs/apk/debug/app-debug.apk`. |
| Web and repository | Next.js production build and TypeScript passed. All 247 npm tests passed before and after the hook change. The two focused endpoint and hook tests passed again with deterministic clocks and jitter. |

## Usage and free-tier assessment

Phase 6 observed a 15.22 MB database, 14 recording sessions in 24 hours, one-day configured retention and four R2 objects totaling 1.125 GB. These are earlier point measurements. Phase 7 did not measure a billing cycle, function CPU, DB connection pool usage, latency, current project-wide consumption or network transfer.

| Monthly model | 1 court | 4 courts | 10 courts |
|---|---:|---:|---:|
| Visible tabs / peak modeled Realtime connections | 1 | 2 | 3 |
| Billed Broadcast messages | 7,200 | 43,200 | 144,000 |
| Estimated Vercel invocations | 265,400 | 1,014,400 | 2,510,400 |
| Estimated Supabase egress, GB | 1.08 | 3.96 | 10.39 |
| R2 Standard storage, GB-month | 21 | 84 | 210 |
| R2 Class A / B requests | 7,800 / 4,200 | 31,200 / 16,800 | 78,000 / 42,000 |

Assumptions are five active hours and twenty 150 MB recordings per court per day, seven-day retention, timely cleanup and a 30-day month. At one-day retention the modeled storage drops to 3, 12 and 30 GB-month. At seven days the storage-only overages are approximately $0.17, $1.11 and $3.00. Actual camera output varies substantially. A healthy tab also renews its credentials and rejoins about every 4.5–5 minutes. Peak WebSocket counts above exclude unrelated clients and transient reconnect overlap.

**Verified zero-cost operation:** no full deployment or billing period qualified for this conclusion. **Conditional:** the modeled Realtime messages/connections fit 2M/200, R2 operations fit 1M/10M, and one noncommercial court at one-day retention could fit the assessed usage allowances. **Likely limits:** seven-day R2 storage exceeds the 10 GB-month allowance in all three scenarios. Four and ten courts exceed one million modeled Vercel invocations. Ten courts exceed 5 GB estimated Supabase uncached egress. **Unknown:** actual CPU, shared quota consumption, retry volume, retention lag and database growth. Vercel Hobby is restricted to personal, noncommercial use. Selling the venue installation rules out promising a Hobby-hosted commercial deployment at $0. [Vercel Hobby](https://vercel.com/docs/plans/hobby) · [Supabase pricing](https://supabase.com/pricing) · [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

## Rollout gates and rollback

1. Use isolated staging credentials, two venues, two admins, a player and enrolled staging devices. Start with the flag off. Verify private-only channel configuration, message-table RLS, RPC exposure and schema grants. Apply the optional migration transactionally to staging with the approved role.
2. Enable `DINKVISION_ADMIN_REALTIME=true` in staging. Check same-venue delivery and denial of other-venue reads and client publishing. Revoke access on an open tab and measure time to denial. Compare two tabs against authoritative snapshots during duplicate, missed and reordered notifications and provider interruption. Confirm flag-off behavior with an already-open tab and a new tab.
3. On staging hardware, cut networking during an active USB recording, background the Activity, finalize locally, queue another authorized recording, restore connectivity and verify one lease and one completed object per recording. Restart with pending uploads. Check playable audio/video from the delivered replay, email recipient, retention deadline and survival of the only local copy through failures.
4. Verify cleanup scheduler cadence against the three-expired-files-per-venue/pass limit. Measure at least one representative busy week of CPU, requests, DB growth, fan-out, egress and retained bytes. Resolve exposed credentials and commercial hosting before production enablement.
5. For consumer rollback, set the server flag to false/unset, roll out that environment through the normal web release process and reload open tabs. Confirm the token endpoint returns 404, sockets close and legacy admin polling reflects a new recording status. The optional producer continues emitting while enabled. If necessary, separately disable only `recording_insert_notice` and `recording_status_notice` on `public.recording_sessions` in an authorized transaction. Keep namespace policies, queue and recording data in place. Rehearse this sequence in staging.

Phase 7 files touched: `components/use-admin-realtime.ts`, `tests/admin-realtime.test.ts` and this handoff. Existing work on the branch was preserved. No deployment, commit, push or production mutation was performed.
