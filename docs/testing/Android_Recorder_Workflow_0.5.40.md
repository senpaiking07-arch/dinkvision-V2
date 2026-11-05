# DinkVision 0.5.40 — HONOR processing recovery

Date: 2026-11-03 (Asia/Taipei). Device: HONOR YAG-W09, Android 16.
Installed local package: `com.casabatik.recorder.dev`; production package unchanged.

## Confirmed cause

A copy of the existing 67-second 1920×1080 recording (54.78 fps) failed at 81% after 262.976 seconds. The captured exception chain ends in `VideoBranding.render`: `Adding the logo took too long. The original video was preserved.` This is the application's elapsed-time guard, not an observed native codec exception. Progress continued steadily up to the failure. The old budget was approximately 261 seconds. About 80 GB of storage was free; the process used about 1.6 CPU cores, and Android thermal status was 0. Concurrent capture was not needed to reproduce this failure.

Original SHA-256 checksums and untouched backup copies are in `.local/honor-logo/`. Both original on-device files matched their initial hashes before the fixed app resumed. Normal successful processing replaces the app copy only after validation; normal successful upload releases it only after backend confirmation. No footage was manually deleted.

## Changes

- Replace the duration-based deadline with a monotonic no-progress check. Successfully encoded media must advance within three minutes; slow, advancing encoding can exceed the former total budget. Repeated timestamps do not reset the timer, and an operation returning after the stall deadline cannot hide the stall.
- Keep bounded media-only diagnostics in app-private `branding-diagnostics.log`, since this HONOR's Logcat did not expose the useful exception. Includes dimensions, source FPS, elapsed time, encoded frame count and processing FPS. No credentials or upload URLs are logged.
- Add authenticated waiting-file presence reports every 30 seconds. They verify the local file and update only contact time, without resetting acknowledged bytes, retry budgets, leases, FIFO positions, or administrator actions. A rejected report cannot starve other waiting files.
- Approved migration `20261103130000_waiting_recorder_presence.sql` was applied and its function definition verified on Supabase project `zjfeavhxqunlqdriroxg`. Only the expiry function and the existing migration ledger were changed. Fresh waiting-file contact prevents false expiry; stale active transfers still expire based on transfer activity. No unrelated device records were modified manually.
- Admin and APK distinguish waiting for logo, measured logo processing, waiting to upload, uploading, processing failure and upload failure. A fresh waiting heartbeat does not resurrect stale processing percentages after restart.
- Prioritize an already branded upload before starting another file, including during retry backoff, so the sole upload worker cannot wait behind its own server FIFO head. Capture remains independent. Existing branded-file reuse, worker limits, server upload ordering and original-file validation remain in place. No resolution, target FPS, encoder or bitrate setting was lowered.
- Project-only debug signing reads `dinkvision.debugKeystore` from ignored `android/local.properties` (or `DINKVISION_DEBUG_KEYSTORE`). Key is outside the repository; global debug keystore is unchanged. Signing certificate SHA-256: `9956e3364853d3e048d6f95e46b23fc3baa6b0ef8eefb1e31e2705b9fba4e14a`.

## Automated verification

- 174 web tests passed; TypeScript checking and production Next.js build passed.
- 25 focused Android tests passed on the HONOR in an isolated diagnostic package: branding, advancing/stalled progress, file reuse, queue recovery, transfer interruption and failure reporting. After the scheduling guard, 7 focused progress/queue tests passed again, including the new branded-head backoff regression.
- Android debug/local APK builds passed. `lintDebug`: 0 errors, 45 warnings.
- Database regression uses isolated PGlite tables: waiting presence preserves retry counts, retained files, uploaded bytes and FIFO order; offline waiters, stale uploading claims and active leases retain their intended behavior.
- API regression verifies authenticated ownership, allowed waiting states, and timestamp-only presence updates.

## Physical acceptance run

Two new consecutive recordings sent to the explicitly authorized test recipient. Captures finalized at 66.958 seconds and 65.927 seconds while existing videos processed. Both are 1920×1080 at the unchanged 60 fps target; measured source rates are 46.98 and 51.73 fps. Both decoded on the host; null-output DTS warnings reflect variable camera timing and do not replace the APK's media validation. Recording and stop/finalize were observed during the screen-lock test.

Sessions:
- Existing A: `799c32f1-1aa4-405c-9209-303e76c3a565`
- Existing B: `cf093ca3-dd93-4ab1-bd3c-a47204d2fcd3`
- New A: `aa98545f-9024-4348-89dc-366f3fe63da6`
- New B: `8449b19d-05c3-446b-a24e-f73af5ac724c`

Existing A and B both completed processing and reached ready in Supabase and Drive with matching byte counts. Existing B's Drive MD5 matched its on-device branded file (`a7f4058b353a08f0cc7e65cc49433b0e`). New A completed processing, then the HONOR-only proxy dropped an upload-status response after Drive acknowledged 4,194,304 bytes. The app was restarted and updated in place with the scheduling guard. Enrollment persisted; New A retried and uploaded successfully. Its branded SHA-256 before restart, after restart and streamed from Drive was identical: `e03e98c7c794bfe961315f82b1e14caa19e1b1f64794618da3e7dbdd32dc496e`. The waiting New B stayed at zero retries. The temporary proxy was stopped and direct ADB reverse to port 3000 restored. New B also completed with zero retries. Final reconciliation found all four sessions and recording files ready, branding complete at 100%, acknowledged bytes equal to file sizes, and matching Drive sizes (123,142,796; 127,244,609; 113,890,542; and 115,004,119 bytes respectively). All four replay email jobs were sent. The APK queue is empty after confirmed uploads, and the authenticated local Admin shows the final recording ready. Evidence is recorded in `.local/honor-logo/final-verification.jsonl`.

## Limitations and remaining manual checks

The no-progress checks run at native-operation boundaries. A native call that never returns cannot be safely killed by throwing a Java exception; forced native-hang recovery remains unverified. The screen-lock processing check observed HONOR suspending progress while asleep and resuming it after wake without a processing failure or additional retry. Sustained screen-off processing therefore remains unverified and needs a device battery/background-policy acceptance check. No guarantee is made for 15/20/25-minute sessions, physical Wi-Fi loss, low-storage/battery operation or physical USB/camera disconnection. Actual capture rates under concurrent processing are below the 60 fps target. Review replay picture/logo placement and audio through the last frame on the target display.

Normal and local-test APK exports are outside the repository in `../DinkVision-APKs/`. No commit, push or web deployment was performed.
