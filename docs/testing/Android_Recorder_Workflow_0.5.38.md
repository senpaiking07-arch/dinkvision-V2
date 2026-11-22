# DinkVision 0.5.38 — direct Android uploads to R2 storage

2026-11-03. Android **0.5.38 / build 44**, debug-signed test candidate. This supplements [0.5.37](Android_Recorder_Workflow_0.5.37.md). No GitHub push or Vercel deployment was performed. No database migration, new dependency or polling-rate change is included.

Superseded by [0.5.39](Android_Recorder_Workflow_0.5.39.md), which records the subsequent real recording/retry/export acceptance run and corrects an acknowledgement bug found during that run. Use the newer APK.

## Data path and workflow

The Android APK now sends video chunks directly to the R2 storage resumable-upload session. Vercel continues to handle small authenticated JSON requests for authorization, queue position, confirmed byte offsets, recovery, completion verification and email scheduling. The large video body no longer goes through `/api/tablet/upload-chunk` from this APK.

1. The normal camera confirmation, recipient entry, confirmation/countdown, capture, local save and logo-validation workflow runs as before.
2. The original device reports the branded recording's size and obtains its existing FIFO queue turn. The backend checks device ownership and the configured private Drive destination, then creates or reuses that recording's resumable session.
3. Requests explicitly opting in with `direct_upload: true` receive `directUpload: { url, bytes, mime }`. The response uses the existing private/no-store JSON helper. The URL is a bearer capability for one upload; Google access/refresh tokens remain on the server. The stored session URL remains encrypted in the database.
4. The APK validates HTTPS, the exact Google API host, the Drive upload path, a session identifier, the expected byte count and MP4 MIME type. The session stays in the worker's memory. It is not saved in the local journal, player state or Admin diagnostics. App cookies and authorization headers are not forwarded to Google. Redirects are not followed, and network errors are sanitized so the session URL cannot enter queue/error messages.
5. Video chunks stream from the private file with a 64 KiB buffer and a maximum 4 MiB request body directly to Drive. The existing foreground upload service, wake/Wi-Fi locks and bounded retry policy remain in use.
6. Small server-side, empty-body Drive probes return Google's acknowledged offset and update Admin progress. Interrupted workers/recreated transports request their session again and resume from that offset. An expired session obtains a replacement through the existing guarded restart action. Missing direct-upload support fails safely before transferring video; the new APK has no Vercel video-relay fallback.
7. Drive accepting the last chunk is insufficient to release the local file. The existing backend finish flow verifies the expected Drive file, size, MIME type and parent folder, applies the existing sharing/email process, and confirms completion. Only then can the APK remove its private source. Failed verification retains the file for retry/export.

The existing manual retry after eight failures, exported-copy removal safeguards and Admin queue cleanup remain. Ordinary browser recorders and older APKs retain their existing backend contracts and video relay. This update specifically reduces Android upload traffic after those devices update.

## Verification

| Check | Result |
| --- | --- |
| `npm test` | **170 passed**, including five new direct-upload/API tests covering queue/ownership boundaries, explicit opt-in, encrypted session storage, confirmed progress and authoritative completion. Existing browser upload/recovery and database-fixture tests passed. |
| TypeScript and production `next build` | Passed. Next 16 uses separate development/build output directories; the local development server was retained. |
| Normal/local/test Android assembly and `lintDebug` | Passed; lint has 0 errors and 44 warnings. |
| Physical Samsung instrumentation | **27 targeted tests passed**: direct upload, URL/credential isolation, lost response and resume, expired sessions, old backend/mismatched grants, missing final confirmation, existing retry/cleanup and enrollment recovery. These use isolated preferences and disposable files. |
| Live phone to R2 storage | **One opt-in physical-device test passed**. A disposable private 5,242,880-byte fixture went directly from the Samsung to Google. A local control harness using the actual Drive client verified file size, MIME type, parent and MD5 checksum. Three empty-body status probes and 441 bytes of JSON control request bodies were observed; that figure excludes headers and responses. The fixture was deleted after success. No real recording, recipient, enrollment or database session was changed and no email was sent. |

The red regression initially demonstrated that the old backend did not return a direct destination; it passed after the change. Evidence is in `.local/fresh-run-20261102/direct-upload-red.log` and `candidate38-{npm-test,typecheck,web-build,build,native-tests,live-phone,live-drive}.log`. The evidence directory retains its earlier date; this candidate was checked on November 3.

The opt-in live test is `DirectDriveUploadTest#liveGoogleDriveSmokeWhenExplicitlyConfigured`, using an explicitly provided local control port. It skips in ordinary instrumentation runs. The local-only `.local/live-direct-drive.ts` harness creates/removes only its own disposable private Drive fixture, reads the configured integration without changing it, and never prints credentials/session URLs.

## Rollout and remaining manual checks

1. Deploy this backend, including `/api/android/release` and direct-session responses. The previous hosted check returned 404 for the release endpoint. Preserve the existing database, Google integration, encryption key and HTTPS app origin.
2. Publish the approved APK at the configured HTTPS download URL and update Android devices over the same package/signing identity. Avoid uninstalling apps that hold enrollment or unsent videos. New APKs contacting an older backend retain saved files and request a backend update rather than relaying video through Vercel.
3. On the hosted site and Device Test, verify one real eligible recording from capture/logo processing through direct transfer, Admin progress, Drive playback, replay email and private-file release. Verify weak-network pause/resume and a locked-screen/background transfer on the intended client tablet. Fault injection and the live transport smoke test do not replace this deployed end-to-end check.
4. Confirm Vercel's path-level transfer usage drops for Android uploads. Existing usage counters will not reset, and browser recorders/older APKs still consume video-relay bandwidth until separately updated. Required-update enforcement remains off until its approved download is published and tested; enable it deliberately afterward.

The earlier client S600/tablet, full-duration and production-signing checks still apply. No new camera compatibility or long-duration certification is claimed.

## APK

`C:\Users\maano\OneDrive\Desktop\Pitch\DinkVision-APKs\Dink-Vision-Recorder-0.5.38.apk`

SHA-256: `a70ca4d44b5dd0a56576639e583f87a05796ddd1e109878b9cdaf77838ae06a7`

The ordinary APK uses `https://dinkvision.vercel.app`. The installed wireless-phone test package is the separate localhost variant. Both use the direct Google video transport.
