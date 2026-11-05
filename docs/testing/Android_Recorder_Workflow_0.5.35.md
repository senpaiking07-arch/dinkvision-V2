# DinkVision 0.5.35 — release candidate verification

Updated 2026-11-02. Android **0.5.35 / build 41**, debug-signed local candidate. This report supplements [0.5.34](Android_Recorder_Workflow_0.5.34.md). No GitHub push or web deployment was performed. Only **Device Test** was used for live device/database scenarios; court devices and their originals were left unchanged.

## Changes and workflow

1. **Required update:** the APK checks `/api/android/release` before player access and periodically afterward. A mandatory newer version displays one blocking update screen. Cached mandatory policy remains effective offline. The native bridge also rejects player/setup actions while gated. An existing recording may finish; saved footage processing/upload recovery remains available to background work. The download URL comes from the authenticated app origin's release policy and must use HTTPS. Browser/Admin access is unaffected.
2. **Enrollment and camera approval:** the one-use enrollment and launch/reconnect camera-check workflow remain. Gmail entry is blocked until the three-second clip is reviewed and confirmed. Returning from another app preserves approval within the same process; restarting the process or reconnecting the camera requires a fresh check.
3. **Video quality:** setup and test review now list camera-advertised resolution/FPS combinations, plus Auto. Combinations the tablet's encoder cannot use, or excluded by the smoothness policy, remain visible but disabled. Java validates the selected key against the current supported catalog. A changed selection invalidates approval and requires a new test. Auto requests the highest compatible 60 fps mode first, compares a fallback when the measured clip falls below that target, and retains the better measured tier/resolution. It does not block an otherwise valid clip merely because actual FPS is below the requested target. Manual selection records one test at that supported choice. The camera review and Admin device details distinguish the requested mode from measured test FPS. A requested 60 fps mode is not proof of delivered 60 fps.
4. **Microphone:** camera USB microphone remains preferred when Android exposes it. The device microphone is the fallback and its identity is reported. Competing voice/camera apps can take or mute microphone input; the test still validates recorded audio rather than approving a silent clip.
5. **Start and retry:** manually enter up to four recipients, review, and start. A failed API start retains that group for retry and does not create a phantom capture. An older unrelated failed clip no longer diverts this group to recovery. If this attempt actually produced recoverable footage, recovery remains explicit. The prepared camera counts 3–2–1; the session timer counts upward from 00:00. Draft addresses clear only when capture starts.
6. **Capture and processing:** free-space preflight scales to the selected bitrate and budgets original plus temporary branded output, audio and reserve. Codec resources are released even when initialization fails or recorder release races with a completed reset task. During branding, rounded duplicate frame timestamps are skipped rather than shifting every subsequent frame forward. Source/video/audio validation remains enabled. A completed, validated output replaces the original safely; failures retain recoverable footage.
7. **Saved videos and Admin:** per-video names, MB counts, measured logo/upload progress, retry/export controls, file inventory, copy receipts and queue order from 0.5.34 remain. A player-facing local-footage warning directs the user to **Saved videos**; raw error details stay with the saved item. Processing clips cannot be previewed prematurely. Server metadata accepts up to 32,000,000,000 bytes for larger recordings; ownership, idempotency, tenant quotas and upload verification still apply.
8. **Notifications and responsive layout:** errors and status messages float outside the screen's grid. Showing/hiding them does not move the headline or buttons. An error takes precedence over an older success message, and unchanged polling does not restart the 30-second timeout. Expired banners disappear; details and Saved videos remain available. The welcome headline uses its available container dimensions on current WebViews, with viewport-based fallbacks. Small portrait confirmation content compacts without page scrolling. Native permission dialogs and fatal startup fallback remain Android-owned.

## Camera target and hardware limits

The client's intended model is **EMEET SmartCam S600**. Its [official specifications](https://emeet.com/products/webcam-s600) list 4K/30 fps, 1080p/60 fps, 1080p/30 fps, YUY2/MJPEG video and dual microphones. **1920×1080 is 1080p.** The current physical tests used a Samsung SM-A226B, Android 13, with the attached **EMEET C60E 4K**, not an S600 or client tablet.

On this Samsung, all reported H.264 encoders rejected 1920×1080 at 60 fps. The camera advertised that mode, but the phone encoder did not. A selected 720p/60 target produced approximately 30 real frames/second in the inspected raw clip. A 1080p/30 test delivered approximately 20 fps on this connection. The UI reports measured results rather than claiming true 60 fps. These measurements are specific to this setup and do not establish an S600 defect.

The [S600 support page](https://emeet.com/pages/webcam-s600-support) provides PC-based firmware/setup guidance. No Android-crash cause specific to the S600 was established by this investigation. Firmware work is a separate manual step using official EMEET software. Do not install firmware merely to satisfy a UI test, or disconnect USB during an update.

## Verification evidence

Final pass counts and device consistency results are recorded below after the final run. Earlier evidence remains in the ignored `.local/fresh-run-20261102/` directory; historical failures are retained alongside the subsequent passing runs.

- Android `assembleDebug`, local/test APK builds, asset integrity checks and `lintDebug`: passed. Lint warnings are retained in the report; passing lint does not mean zero warnings.
- Next.js production build: passed (`candidate35-web.log`).
- Node/API/database regression suite: **161 passed** (`candidate35-node-final.log`).
- Native regression suite, including the real 30-second toast timeout and viewport matrix: **60 passed** (`candidate35-native-final.log`, 82.26 seconds).
- Physical successive-camera resource-release check, six-second screen-lock capture and incomplete-audio rejection: **3 passed** on the final candidate (`candidate35-hardware-final.log`, 58.444 seconds). The resource-release case records ten consecutive clips.
- A previously failed approximately 93-second capture was retried after the branding fix: database reports uploaded, branding complete at 100%, 67,364,478 bytes. The original was backed up privately during diagnosis.
- Live start-failure/retry and final Device Test reconciliation remain for manual validation at the user's request. The new quality-selection flow was not completed; no pass is claimed for that final live check.

The latest normal APK is exported to `../DinkVision-APKs/Dink-Vision-Recorder-0.5.35.apk`, outside the checkout, with a SHA-256 sidecar. The export task no longer duplicates it in the root and `artifacts`. Android Studio's managed build output remains available for installation/debugging.

### Follow-up: false “Recording unconfirmed” banner

The real Device Test session `56bb62a6-5f5d-49ad-96cf-556effb98931` was observed recording at 87 seconds, with no native capture error and a 900-second limit. Admin's authenticated database role could read the parent session but returned no private `browser_recordings` rows under RLS. The embedded empty report therefore produced a false stale warning.

The Admin server page now retrieves only safe report fields for session IDs it has already obtained through the signed-in administrator's RLS-authorized session query. URL IDs alone never authorize that service read. Database policies were left intact. A regression reproduces the empty authenticated relationship and verifies fresh reports, missing/inaccessible IDs and non-admin rejection. Eight focused Admin/tenant tests and TypeScript checking passed. A subsequent read shows the real session is ready, its upload completed, and branding reached 100%; no stop/reinstall was issued during this diagnosis. Another live capture on the refreshed Admin screen remains a manual check.

Viewport assertions cover **320×480, 360×640, 384×832, 568×320, 600×960, 768×1024, 800×1280, 1024×600, 1024×768, 1280×800, 1600×2560 and 2560×1600** in the physical phone's WebView. Checks cover background selection, welcome/form/confirmation/session/test/saved screens, modal/update bounds, 44 px touch targets, quality selection/retest gating, no document overflow, notification stability and no headline clipped behind the header. This verifies responsive geometry; it does not certify another tablet's camera hardware.

The reported VS Code message, “The build file has been changed and may need reload to make it effective,” is an informational Java-project reload notice. The IDE was inspected; automatic interaction stopped when user activity was detected. Reload the Java/Gradle project when convenient. The successful command-line build/lint results are independent evidence; no claim is made that the IDE reload was completed.

## Activate required updates only after publication

Enforcement is intentionally **off** until an approved APK is downloadable. No site download URL has been published by this work.

The hosted `https://dinkvision.vercel.app/api/android/release` returned **404** during the final export check. A fresh install of this strict-gate APK can remain on its update-check screen until the backend route is deployed. The localhost test backend provides the route. The normal APK is built, but hosted/client distribution requires that backend publication first; no push or deployment was performed.

1. Verify the normal APK on the intended tablet/S600 combination and sign it with the key used for existing client installations. The `com.casabatik.recorder.dev` localhost test package is a separate app and is not the client release.
2. Publish the approved normal APK at the chosen HTTPS URL on the app site. Verify an unauthenticated download returns the APK, the expected SHA-256, version and matching signing certificate.
3. Set `ANDROID_APK_DOWNLOAD_URL` to that URL. Then deliberately enable `ANDROID_REQUIRE_LATEST=true` in the deployed backend and verify `/api/android/release`.
4. Check an older gate-capable APK is blocked, the current APK is admitted, existing data survives install-over-existing-data, and uploads are not discarded. Android still requires the user to approve installation; the app cannot silently replace itself.
5. Older APKs that predate this gate need an initial manual update. Server rejection can prevent their new captures, but cannot add the new fullscreen prompt to an already installed old binary. Do not uninstall to update: uninstalling erases private recordings and enrollment.

## Manual release checks still required

- **Client tablet + S600 + actual cable/powered OTG:** verify mode list, real 1080p/60 delivery, camera microphone, logo placement and sound through the final frame. Run complete 15-, 20- and 25-minute sessions under venue lighting/thermal conditions. The earlier 15-minute success on another mode is not certification of the new high-resolution path.
- **Real interruptions:** incoming calls/Discord, mic privacy switch, USB/power removal, battery saver/low battery, storage exhaustion and unexpected shutdown during capture, branding, export and upload. Confirm recovery when the device restarts. Software process-interruption tests do not equal sudden physical power loss.
- **Network/cloud:** sustained poor bandwidth, large-file limits, server outage, long retry exhaustion and recovery with queues of two through five. Verify each replay goes to its own original recipients and exported copies remain usable.
- **Presentation UI:** inspect actual tablet portrait/landscape, its keyboard, font scaling, display cutouts and rotation. Responsive WebView assertions cannot verify OEM keyboard and system overlays on every device.
- **Hosted release:** deliberately publish backend/migrations/configuration, production signing and scheduler settings after review. Validate the exact hosted APK/site combination; the currently installed phone candidate uses the local backend.

No blanket “all cameras/all tablets stable” certification is implied. The release remains a tested candidate until the intended client hardware and published build pass these checks.
