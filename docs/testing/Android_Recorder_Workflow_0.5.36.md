# DinkVision 0.5.36 — saved-video cleanup and retry

2026-11-02. Android **0.5.36 / build 42**, debug-signed test candidate. This supplements [0.5.35](Android_Recorder_Workflow_0.5.35.md). No GitHub push or deployment was performed.

## Player workflow

- **Save to device** exports a separate copy to Gallery/Files. It does not silently remove the original. After export, the main action becomes **Remove from app**. **Details → Save another copy** remains available.
- Removal requires confirmation, current device ownership, a terminal/non-processing item, and no conflicting capture/upload/export work. Native code rechecks that the saved export can be opened and has the expected byte count. A missing, moved, shortened or inaccessible export prevents removal; save another copy first.
- Removal only unlinks that UUID-named recording inside the app's private recordings directory. Gallery/Files and Drive copies are untouched. The operation journals intent before unlinking, completes its tombstone afterward, and retains export receipts. Interrupted removal can complete on restart. An inaccessible export preserves the original and does not prevent other queue entries from reconciling.
- The private item disappears from Saved videos after removal. A durable presence report updates its own database record when connected. Removal history is retained; it is not confused with an unexplained missing-file failure.
- A successful upload continues to remove its private source only after the cloud transfer is verified. Merely reaching 100% bytes sent, or a failed upload, is insufficient.
- **Retry upload** remains available after eight failed attempts and starts a new bounded automatic retry cycle for the same recording/recipients. **Retry now** is also visible for a scheduled retry. It advances that scheduled attempt without silently resetting its existing attempt count. Repeated actions do not create a second recording or duplicate queue item.
- A cached server session no longer blocks Gmail entry when the app already has an ownership-matched acknowledgement that its capture was released. The new start still checks current server authorization and capture exclusivity. Genuine in-progress captures remain protected.
- The stretched default video poster is replaced by a local 16:9 background. The native player supplies the play control; there is no second drawn play icon. Video/poster content uses `object-fit: contain` and centered positioning.

## Admin

Uploaded items whose private copy has been released, and items explicitly removed from the app, leave the device card's queue about **10 seconds after the server update**, subject to the three-second refresh interval. They remain searchable in Recording logs. Queue counts and the device card's summary use the same visibility rule. Unsent local videos, waiting/retrying items and unexplained missing-file failures are not hidden.

Intentional removals display **App copy removed** during that brief completion period. If an exported-copy receipt exists but the cause of private-file loss is unknown, Admin says **App copy unavailable · export recorded**; it does not claim that the Gallery file still exists.

The 0.5.35 Admin report lookup correction is retained: privileged report reads are limited to IDs from the signed-in Admin's RLS-authorized session query. Database policies were not relaxed. Existing ownership-filtered queue-report and device-copy APIs carry the new cleanup reports; this change adds no schema migration.

## Verification

- Android normal/local/test APK builds and `lintDebug` passed. Lint reports 0 errors and 44 warnings.
- **16 focused Android instrumentation tests passed**, covering Saved videos UI at the 12 viewport sizes documented in 0.5.35, confirmation/cancel behavior, export retention, removal, retry budgets, interruption recovery and queue reconciliation (`candidate36-native-tests.log`).
- The final saved-video recovery suite passed again: **10 tests**, including an interrupted removal with an unavailable export (`candidate36-removal-final.log`). Tests remove only disposable fixture files/copies.
- Targeted Node/API/workflow regressions passed: **31 tests** (`candidate36-web-regressions.log`), plus the **2 database/upload-queue suites** (`candidate36-deletion-tests.log`). Those database suites include removing active/uploading devices, releasing the global upload lease immediately, retaining historical logs, and deleting courts without historical sessions blocking removal.
- Final Admin queue/status tests passed: **12 tests** (`candidate36-admin-queue-tests.log`). They verify the ten-second boundary, retained unsent work and missing-file warnings, Admin authorization and stale capture reports. TypeScript checking passed.
- On physical **Device Test**, the previously exhausted upload `2b094bd4-4ba3-42f8-9125-ef171a7feead` completed after retry: 147,402,673 bytes, branding complete at 100%, database upload state `uploaded`, private availability `false`. The queue-visibility rule excludes that completed item. The actual user recordings were not manually deleted during testing.
- The phone's localhost tunnel was lost when wireless debugging was toggled. Restoring ADB reverse restored API contact and cleared the cached recovery state. This was a local development connection issue, not proof of a capture or USB-camera failure. Hosted APKs use the configured HTTPS origin instead of that tunnel.

No new long camera recording or hardware certification is claimed. The final source still needs the intended client tablet/S600 checks from 0.5.35, plus manual inspection of the final preview graphic, removal of a chosen exported test clip, offline removal/report synchronization and the ten-second Admin disappearance in the actual browser.

## Build and handoff

The shareable APK is outside the checkout:

`C:\Users\maano\OneDrive\Desktop\Pitch\DinkVision-APKs\Dink-Vision-Recorder-0.5.36.apk`

Its SHA-256 sidecar is alongside it. No new APK copy is exported to the project root or `artifacts`. Android Studio retains its normal managed output. The wireless phone uses the separate localhost test package; the shareable APK uses the hosted origin.

**Hosted distribution prerequisite:** the last checked hosted `/api/android/release` endpoint returned 404. A fresh installation of the strict update-gate APK can remain blocked at update checking until the new backend route is published. Required-update enforcement remains off until the approved HTTPS download is available. Backend publication/signing/client-hardware validation remain deliberate release steps; this work did not push or deploy them.
