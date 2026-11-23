# Phase 5 Android Realtime integration

Reviewed on branch `codex/r2-local-integration`. Android Java/Gradle debug APK version **0.5.52**, build **58**, min SDK 26, target and compile SDK 36.

## Scope and files

This handoff is the only Phase 5 source-controlled change. The recorder already implements the device-side HTTP synchronization selected by Phase 2. Phase 2 describes an optional foreground monitor for a separately authenticated administrator. Phase 3 implements only the admin receive channel and Phase 4 supplies an opt-in web consumer. The recorder has a device enrollment, so there is no approved Realtime manager, event subscription, or authentication refresh flow to add to this APK.

The approved Broadcast event is `recording.transition` on `tenant:{uuid}:admin-status`. A verified administrator with access to that venue can receive it after passing the policies in the Phase 3 migration. The Android recorder stores the `cb-kiosk` enrollment cookie in its private vault. The backend resolves the active device and venue from the hashed cookie and scopes subsequent operations to that identity. The Phase 4 snapshot/token endpoint requires the existing Supabase user session and matching admin scope. Device credentials confer no admin-channel permissions.

## Android lifecycle and recovery

- `MainActivity.onResume` marks the UI visible and requests transfer resumption. `onPause` changes visibility and `onDestroy` releases WebView and USB receiver resources. The activity shares an application-scoped Engine with the foreground recorder and transfer services. Service shutdown, Android data-sync timeouts and explicit pause/cancel remain handled by their existing paths.
- `Engine.start` uses the authenticated tablet HTTP API to reconcile device configuration and reserve a session before starting a new recording. A fresh match cannot be authorized while the backend is unreachable. Once capture has started, the camera reports its progress locally and sends the status report on the heartbeat executor. Finalization verifies the sealed output and journals the MP4 and queue entry before dispatching an asynchronous status report. This is static code verification of network independence during an active capture and local save.
- The device heartbeat uses a five-second fixed delay after each run. The heartbeat executor handles remote state, presence and recovery separately from the capture and upload executors. HTTP requests have bounded timeouts, and the engine reconstructs local recovery state when the process initializes. Reboot interrupts the active process. Queue recovery is evaluated when the recorder initializes again.
- The transfer worker keeps the existing lease ordering and uses HTTP to acquire upload authorization and verify completion. The video parts go directly to R2. Cleanup requires verified upload state and current device ownership, and pending uploads can continue independently of UI visibility subject to the Android foreground-service policy. Upload retries and local footage use the existing persistent journal.

## Verification

- Gradle `:app:compileDebugJavaWithJavac :app:testDebugUnitTest :app:lintDebug :app:assembleDebug -x :app:exportDebugApk` succeeded. The unit-test task reported NO-SOURCE. Excluding the export task kept the generated APK at Gradle's output path and preserved the separate shared APK.
- Gradle `:app:compileDebugAndroidTestJavaWithJavac` succeeded. Enrollment, reconnect, local queue recovery, R2 multipart and background transfer instrumentation compiled. These tests require an Android test installation and were not executed in this phase.
- The 29 targeted tests passed across android release/timer, recorder events, R2 protocol and upload, tenant isolation, admin Realtime and upload queue. They cover simulated missing/invalid admin authentication, denied access, duplicate events and reconnect behavior on the web consumer, as well as existing device, tenant and queue contracts.
- Verified the APK manifest identity with `aapt dump badging` and APK Signature Scheme v2 with `apksigner verify`. APK path: `D:\DinkVision V2 Cloudflare R2\dinkVision\android\app\build\outputs\apk\debug\app-debug.apk`. This is the debug variant. No installation, production signing operation, deployment, or live Supabase change was performed.

## Remaining device validation

On an isolated enrolled tablet, start a recording with the API reachable, disconnect networking during capture, and confirm local finalization and replay of the saved clip. Restore networking and verify a single queue entry resumes for the same session. Background the UI during transfer and verify the foreground service and local-copy policy. Repeat with process restart and with reboot after finalization. Use a dedicated test device because existing instrumentation includes test fixtures that reset application state. Validate admin-channel joins and revocation separately on staging from an authorized web session.

[Supabase Realtime authorization](https://supabase.com/docs/guides/realtime/authorization)
