# DinkVision 0.5.39 — physical Device Test acceptance

2026-11-03, Asia/Shanghai. Latest Android **0.5.39 / build 45**, debug-signed. Physical target: Samsung SM-A226B, Android 13/API 33, connected EMEET SmartCam C60E 4K and its USB microphone. Tests used only **Device Test**, the localhost test package and local Next.js backend against the configured Supabase database and real Google Drive/Gmail integration. The hosted Vercel deployment was not updated or certified. No GitHub push, deployment, database migration, polling optimization or dependency change was made.

## Passed on the phone

| Area | Evidence |
| --- | --- |
| Enrollment and identity | Registration survived installation over the existing package. APK/Admin reported the same enabled Device Test; one enabled Admin slot was found for that kiosk. No new enrollment code was used. |
| Camera and audio | Fresh three-second checks used the EMEET USB microphone. The user confirmed picture and sound, including the final 0.5.39 check. Observed profile: 1280×720, 60 fps target, approximately **30.1 fps delivered** on this connection. No 60 fps delivery or client S600 certification is claimed. |
| Entry and navigation | Camera approval gated Gmail entry. Back worked. Empty/invalid/duplicate addresses and a fifth address were rejected; four addresses fit without document scrolling. Added test aliases were removed before capture; the actual replay used only the authorized Gmail. Next-group entry began empty. |
| Keyboard and timer | Focusing Gmail kept document height/form position stable, with the field visible and no DOM scrolling. Countdown observations were 3, 2, 1, then recording near zero. Foreground timer samples advanced 00:29, 00:30, 00:31, 00:32, 00:33. |
| Real capture | First test recorded approximately **85.13 seconds** and continued when minimized. The database reported recording with fresh contact while the app was away. Stop/finalize succeeded. |
| Direct upload and retry | Branded file: **72,374,018 bytes**. An acknowledged status response was deliberately hidden after Drive had **20,971,520 bytes**. The local video remained retryable; the real Saved videos **Retry now** button was present and usable. After restoring the connection, the next confirmed offset was still 20,971,520, then increased to completion. No second recording/file was created by retry. Five failed attempts in this run included deliberate test tunnel/metadata interruptions; these were not spontaneous production failures. |
| Background concurrency | The next test recording started while the prior replay was retrying. It recorded approximately **25.30 seconds**, including while the screen was locked, as the earlier replay uploaded. Stop succeeded while locked. |
| Screen-off work | The long replay completed its upload while locked. The short clip then processed its logo with the screen off; real progress samples included 86, 88, 92, 95 and 99%, followed by database completion at 100%. |
| Drive, email and source release | The long recording/file reached ready; the correct recipient matched `maanopetergil@gmail.com`; Gmail accepted the replay email. The user confirmed logo, picture and audio through the end. The app released its private copy only after backend completion; database `local_available` became false. The test proxy observed **zero `/api/tablet/upload-chunk` requests** from the new APK. This is local transport evidence, not a measurement of live Vercel billing counters. |
| Local-only clip and playback | The short clip correctly stayed local without upload/email. Its preview played: readyState 4, advancing time, duration approximately 25.35 seconds, 1280×720 media, `object-fit: contain`, no media error and no document overflow. |
| Export and manual removal | Exported the new short test clip to Gallery. Removal cancellation retained its private file; confirmation removed it. The separate Gallery file remained **21,079,602 bytes** afterward, matching the export receipt in the database. Only the new test clip was manually removed. |
| Data preservation | The five pre-existing private videos remained present, with their original IDs and byte counts. Their contents were not manually deleted. Both new test records remain in database history. |

## Bug found and fixed

The physical removal test exposed repeated presence reports for a removed item. The merge that protects removal tombstones against stale upload/branding workers also restored `presenceReportPending: true` after an acknowledgement tried to clear it. Repeated requests refreshed `upload_updated_at`, delaying Admin's ten-second disappearance rule.

0.5.39 acknowledges the matching report atomically in the current journal, checking ownership, file presence, removal generation and status. Failed requests keep their pending flag. Ordinary stale-worker protection remains in place. A regression test failed before the fix and passed afterward, including stale worker writes and process restart.

The actual short test record stopped refreshing after the update. Its last cleanup report was **2026-11-03 01:03:59 +08:00**; it was unchanged and hidden by the Admin queue filter more than 30 seconds later. The uploaded replay was likewise hidden from the transient queue. Gallery-copy receipts and recording history remained. Admin visibility was checked using its shared queue filter against actual database records; a separate authenticated browser visual check was not performed in this run.

## Automated verification

- Original 0.5.38 transport candidate: full `npm test` **170 passed**, production web build/typecheck and Android assembly/lint passed; 27 focused Android tests and a real disposable phone-to-Drive checksum test passed before this acceptance run.
- Final 0.5.39: **29 focused Android tests passed**; one additional opt-in live-fixture test was skipped in that ordinary run (runner reports 30 tests). Tests cover direct transport, retry/confirmation, enrollment, file manifests, export/removal and the new acknowledgement regression. All use isolated fixture preferences/files.
- Final queue/direct-upload/release tests: **10 passed**. Production web build (including TypeScript checking), normal/local/test APK assembly and `lintDebug` passed, with 0 lint errors and 44 warnings.

Evidence: `.local/device38-acceptance-20261103/` contains state observations, sanitized fault-proxy events, stop times, database snapshots, playback/export/removal results, email outcome, the failed regression and final build/test logs. The evidence folder retains the starting candidate's version in its name. No cookies, OAuth tokens or upload capability URLs are logged there.

## Handoff and remaining checks

The corrected 0.5.39 localhost test app is installed over the existing app on Device Test. Enrollment and the five earlier private videos remain. The user confirmed its fresh camera check. The temporary fault proxy was stopped and the original localhost ADB reverse mapping restored. The long emailed replay and the exported short test clip remain available for review.

Remaining checks are the matching backend/APK rollout on the actual hosted Vercel site, followed by a hosted capture-to-email run; client **tablet + EMEET S600** compatibility and actual resolution/frame rate; full configured 15/20/25-minute sessions; and controlled low-battery/storage, call/system interruption and physical power/USB/hub interruption tests on the intended client hardware. These are not certified by this shorter Samsung run. Keep required-update enforcement off until the approved APK URL is published and tested. Older APK/browser upload paths still relay video through Vercel until separately updated.

Latest shareable APK, outside the repository:

`C:\Users\maano\OneDrive\Desktop\Pitch\DinkVision-APKs\Dink-Vision-Recorder-0.5.39.apk`

SHA-256: `a12ec24583d6e61ce82c1ebfcbeffadcaa87c24db182a7ec9669e206486389ad`

The normal APK uses the hosted HTTPS origin; the device used the separate localhost package for these tests. No broad claim of error-free behavior on all devices or production readiness is made.
