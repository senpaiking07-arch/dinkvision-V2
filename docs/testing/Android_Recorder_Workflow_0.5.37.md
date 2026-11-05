# DinkVision 0.5.37 — enrollment through connection outages

2026-11-02. Android **0.5.37 / build 43**, debug-signed test candidate. This supplements [0.5.36](Android_Recorder_Workflow_0.5.36.md). No GitHub push or deployment was performed.

## Registration lifecycle

An enrollment code is single-use and expires **10 minutes after creation**. Once consumed successfully, it is replaced by a persistent device credential. Reconnection uses that credential, not the expired code. The Android app stores it in its existing encrypted, device-local vault. An internet outage must not erase it or silently re-enroll the device.

Uninstalling/clearing app data, intentionally replacing registration, or Admin disabling/deleting/revoking a device are separate events. Server authorization remains authoritative. A saved credential does not make a disabled or unrecognized device active.

The reported phone outage was traced to the localhost test package losing its ADB reverse tunnel after wireless debugging changed. Restoring the tunnel restored its existing enrollment. The normal APK uses the configured HTTPS origin and does not depend on ADB reverse.

## Changes

- API responses are validated before their cookies are persisted. Timeouts, non-success statuses, redirects and malformed deployment responses cannot erase or rotate the saved device credential.
- Only a successful enrollment response with `ok: true` may replace `cb-kiosk`; ordinary state polls cannot replace it. Empty/deletion cookies do not clear the saved registration. TLS verification remains enabled.
- Automatic reconnect clears its own stale connection error while preserving unrelated USB/capture errors. The saved-enrollment recovery modal closes when an enabled assignment is retrieved successfully. An intentionally opened replacement-enrollment form stays open and retains its input.
- Recovery text explains that the registration remains saved during an outage and that a fresh code is unnecessary. A confirmed inactive/unrecognized registration has a distinct Admin-attention message.
- The existing hosted state API returns a retryable 503 for database unavailability, rather than incorrectly reporting the device as unenrolled. Confirmed missing/revoked registration still returns `enabled: false`.

## Verification

- Android normal/local/test APK assembly and `lintDebug` passed; lint reports 0 errors and 44 warnings.
- Six focused Node/API/database-fixture tests passed, including expiration of a consumed enrollment code without invalidating its active device credential, one-use enrollment, Admin replacement protection, required-update behavior and hosted database-outage handling.
- TypeScript checking passed.
- Five isolated Android enrollment/connection tests passed on physical Device Test: repeated timeout/reload/reconnect using the original credential; 502/503/504/401/redirect/malformed responses; enrollment-only credential replacement; clearing only the connection error; and respecting revoked registration. These use fake transports and isolated encrypted preferences, not real enrollment codes or live database mutations.
- The accompanying local-file and required-update checks passed (three additional Android tests). The first Saved videos UI run encountered a locked phone and a zero-sized WebView. Its unlocked rerun passed in 52 seconds, including reconnect/replacement-form behavior and the twelve phone/tablet viewport sizes from 0.5.36. All **nine targeted Android tests** passed across the initial run and this rerun.
- After instrumentation, Device Test reopened as 0.5.37 with its existing enrollment enabled, initialized, idle and without a connection error. No fresh enrollment code was entered. The localhost ADB tunnel remained the development transport.

Evidence is in `.local/fresh-run-20261102/candidate37-{build,web-tests,typecheck,native-tests,ui-unlocked}.log`. Simulated repeated failures do not represent hours of elapsed offline testing. No new long recording, client S600/tablet certification or live Vercel outage test is claimed.

## Hosted rollout and remaining checks

The live `https://dinkvision.vercel.app/api/android/release` endpoint returned **404** during this check. Deploy the matching backend, including that route, against the intended Supabase database before distributing this strict-gate APK. Keep `APP_ORIGIN` set to the actual HTTPS site and preserve existing credentials/configuration, including `TOKEN_ENCRYPTION_KEY`. Do not enable required-update enforcement until the approved APK is downloadable at its configured HTTPS URL.

On a disposable hosted test registration: enroll once, disconnect internet for more than ten minutes, restart the app while offline, reconnect and verify the same Admin device/assignment returns without another code or duplicate device. Separately disable/revoke that test registration and verify it is rejected. These hosted checks remain pending deployment; local/fake-transport checks do not substitute for them.

The previous candidate's remaining client tablet/S600, long-duration and release-signing checks still apply.

## Build

The shareable APK and SHA-256 sidecar are outside the checkout:

`C:\Users\maano\OneDrive\Desktop\Pitch\DinkVision-APKs\Dink-Vision-Recorder-0.5.37.apk`

Its generated build configuration identifies `https://dinkvision.vercel.app` as its origin, package `com.casabatik.recorder`, version 0.5.37 / build 43.

The physical Samsung uses the separate localhost test package. Installing an update over the same package/signing identity preserves its data; uninstalling does not.
