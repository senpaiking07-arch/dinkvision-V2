# Phase 3 implementation

Branch: `codex/r2-local-integration`. Local implementation, pending staging verification.

Phase 1 found an existing visibility-aware polling path and no runtime Realtime subscription. Phase 2 selected authoritative snapshots, private Broadcast hints for low-volume changes, and polling reconciliation. This first producer covers recording-session creation and actual status changes. Heartbeats, camera diagnostics, upload progress and email remain available through existing APIs.

## Files

- `supabase/optional-migrations/20261124000100_private_recording_notifications.sql` implements receive authorization, client write restrictions, the transactional producer and a bounded cursor. Kept separate from the default migration runner so ordinary deployments do not enable broadcasts before project settings have been verified.
- `lib/recording-transition.ts` validates the complete consumer envelope, tenant and increasing version.
- `tests/tenant-isolation.test.ts` exercises the new migration alongside the existing tenant schema and access model.
- This handoff records the rollout and consumer contract.

## Wire contract

Private topic `tenant:{canonical-uuid}:admin-status`, Broadcast event `recording.transition`. The payload has exactly seven fields:

| Field | Meaning |
| --- | --- |
| schemaVersion | Integer 1 |
| type | Literal recording.transition |
| tenantId | Venue UUID from the persisted session |
| entityId | Recording session UUID |
| eventId | Random event UUID |
| version | Positive integer increasing within this venue's emitted notifications |
| occurredAt | Timestamp with UTC offset |

Maximum payload 1 KiB. Fixed keys, UUIDs, literals, bounded timestamp and a safe integer keep valid envelopes below the limit. A hint means refresh the venue snapshot. The entity identifies the session that triggered this hint; other sessions can have changed during the coalescing interval. The timestamp describes event creation. Use version for ordering.

## Authorization and failure handling

Private Broadcast receives require a verified Auth user, active venue and the existing is_tenant_admin check (active membership/profile or active super-admin). Exact topic comparison and restrictive RLS policies limit other permissive policies in the reserved namespace. Anonymous clients, device credentials, and ordinary players have no subscription grant. Clients cannot publish into the reserved namespace. The payload excludes footage, credentials, player identifiers and recording details.

The trigger sends through realtime.send in the same DB transaction. Rolled-back writes cannot produce committed messages. Notification exceptions roll back the optional producer work and leave the recording mutation intact. Concurrent producers try a transaction advisory lock and drop the hint on contention. A single cursor per venue caps emission at one hint per five seconds across all sessions. This intentionally permits missing hints. The cursor is internal, and version counts emitted notifications rather than all database changes.

## Rollout and verification

1. Use an isolated Supabase staging project with the current core migrations. Verify RLS enabled on realtime.messages, private-only channels configured (disable Allow public access), authenticated JWT refresh configured, and private helper and realtime schemas excluded from exposed Data API schemas. Inspect existing grants, policies and any exposed RPC able to send arbitrary messages.
2. Apply the versioned optional SQL once in a transaction with a migration role allowed to manage policies on realtime.messages. Record it in the deployment ledger. Keep clients on polling.
3. With real WebSocket clients verify confirmed admin receives, other venue/player/anonymous/device joins denied, admin publishing denied, and public channels cannot receive private broadcasts. Test membership revocation on open channels and token refresh; Supabase caches channel authorization. Confirm acceptable revocation latency before enabling clients. Exercise commit, rollback, reconnect and provider outage. Measure latency of trigger execution under load because it runs inside the recording transaction.
4. Phase 4 web: feature flag initially off. Get the existing authenticated snapshot, authenticate Realtime with the current user's JWT, subscribe privately, and reconcile again after subscription succeeds. Pass event.payload, selected tenant and the last accepted venue version to isNewRecordingTransition. Coalesce accepted events into a venue-wide snapshot refresh. Reconcile on focus, reconnect, gaps and periodic polling. On tenant or account switch unsubscribe, discard pending results and reset the cursor. On auth failure close the subscription. Avoid overlapping fetches and stale responses.
5. Phase 5 Android: retain current device HTTP authentication and all recording/upload contracts. Device enrollment tokens cannot join this channel. An optional admin-authenticated foreground monitor can use the same envelope and reconciliation steps. Release it on backgrounding. Recording, queue leases, direct R2 multipart completion and cleanup continue through their existing paths.
6. Roll back consumers by disabling the feature flag. To stop production of hints, disable recording_insert_notice and recording_status_notice on public.recording_sessions through an authorized migration. Keep the namespace policies in place.

## Checks

TypeScript typecheck passed. All nine targeted tests in tenant-isolation, tenant-routes, r2-schema and upload-queue passed. PGlite executed the real application migrations, SQL policies and producer; auth claims and the Realtime transport were simulated. The focused check includes cross-venue and missing identity, forged publish attempts, payload rejection, duplicate suppression, unchanged status, coalescing and a producer exception during a durable status transition. Existing suites exercise device and queue isolation. Live Supabase joins, socket revocation timing, managed service privileges, production throughput and deployment remain unverified.

Provider references: [Authorization](https://supabase.com/docs/guides/realtime/authorization) and [Database Broadcast](https://supabase.com/docs/guides/realtime/broadcast).
