# Phase 4 web integration

Implemented locally on the codex/r2-local-integration branch. The server-side DINKVISION_ADMIN_REALTIME flag defaults to off. Enable it on staging after the Phase 3 optional migration and private-channel setting have been verified.

## Changed files

- app/admin/page.tsx renders the authorized snapshot and passes the selected account and venue to the dashboard.
- lib/admin-dashboard-snapshot.ts shares the existing bounded dashboard queries and capture-report authorization between the page and the snapshot route.
- app/api/admin/dashboard-snapshot/route.ts serves private, uncached snapshots. Its same-origin POST supplies the signed-in user's access token to the subscriber. Both methods validate the server-resolved account and venue against the dashboard scope.
- components/admin-dashboard.tsx owns the single subscription for all dashboard tabs and renders a stale-data notice when reconciliation fails.
- components/use-admin-realtime.ts owns the socket, visibility and network lifecycle, and snapshot scheduling.
- tests/admin-realtime.test.ts exercises the route and client lifecycle with simulated transport.
- tests/admin-recording-status.test.ts, tests/admin-schema-compatibility.test.ts and tests/recording-log-link.test.ts update the existing test harnesses for the subscription hook and shared snapshot loader.

## Subscription and reconciliation

The authorized Next.js page supplies the initial snapshot. The dashboard uses one private Broadcast subscription per visible, online admin tab. All dashboard panels share the updated snapshot. The browser uses the existing Supabase JavaScript SDK and publishable key. The access token stays in memory. Session refresh continues through server-managed HttpOnly cookies.

The only subscribed message is Phase 3 recording.transition on tenant:{uuid}:admin-status. The existing decoder checks scope, schema and a strictly increasing version. Every accepted hint schedules an authorized snapshot, including after a version gap. The UI uses database results as its source of truth. Reads are serialized and coalesced, with a five-second minimum between hint-triggered read starts. Hidden tabs, offline transitions and unmount abort reads and close the connection. Visibility or connectivity recovery reloads the snapshot and rejoins. Channel failures retry with capped exponential backoff and jitter. The hook periodically rejoins with current credentials to recheck the account and membership.

With the flag enabled, the 30-second page refresh is replaced by a snapshot endpoint. A connected dashboard reconciles at 60 seconds during idle periods. Disconnected dashboards reconcile at 30 seconds. Manual page refreshes used by mutations remain. Lightweight device summaries and the Cameras panel's diagnostics polling continue to serve device presence, camera state and upload progress.

## Performance and rollout

The timer settings imply two scheduled full-route refreshes per minute before opt-in, and zero scheduled full-route refreshes with opt-in. During a quiet connection the new schedule produces about one snapshot request per minute, plus join/renewal requests. During bursts the hint-driven snapshots can increase request volume. These are schedule-derived estimates. Browser traffic, latency, memory, render counts, provider fan-out and Vercel invocation costs have not been measured against a deployed environment.

On staging, validate real authenticated joins and revocation after account or venue access changes, including logout across tabs. Measure idle and busy sessions against the flag-off baseline. Verify transitions across multiple courts and rapidly changing recordings. Measure the 60-second freshness window for fields that are not covered by Phase 3 events. The browser receives the current admin access token in memory, so validate existing content security controls and the intended browser trust model before enabling the flag. Keep the flag off if the staging policy or freshness checks fail.

## Validation results

All 247 tests passed after the existing harnesses were updated. The two new focused tests passed again after explicit channel teardown was added. TypeScript, the Next.js production build and git diff --check passed. This repository has no lint script or ESLint configuration. Hosted Supabase tests and deployment are pending.
