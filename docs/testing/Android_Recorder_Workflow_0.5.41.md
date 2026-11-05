# DinkVision 0.5.41 / build 47 — local follow-up

2026-11-04, Asia/Taipei. HONOR YAG-W09 with EMEET SmartCam S600.

## Baseline and preservation

Started on `main` with extensive existing uncommitted work. Recorded the starting tracked diff and hashes of tracked/untracked source files in ignored `.local/honor-followup/`. The installed local app and source were verified as 0.5.40 / 46.

Preserved the existing single processing/upload worker, capture exclusivity, branded-file reuse, bounded retries, queue-presence reports, approved expiry migration, audio routing, encoder quality settings, validation and file recovery. No new database migration or manual shared-record mutation was made. Local Next.js still uses hosted Supabase project `zjfeavhxqunlqdriroxg`. Database checks were read-only; regression database tests used isolated fixtures.

No uninstall, data clearing, enrollment reset, real-footage deletion, Gallery cleanup, commit, push or deployment. The previously supplied project signing key remains outside the repository; the global key was not changed. The build-generated `next-env.d.ts` change was restored to its exact starting hash. No unrelated source files were changed or removed.

## Confirmed findings

The old total processing deadline was already fixed. The current 25-minute source passed that deadline, but software libopenh264 cannot keep pace with continuous capture on this HONOR. At the first observation it had reached 38% after 2,991.8 seconds, averaging 9.04 encoded FPS; recent intervals were about 10.9 FPS. CPU was about 1.75 cores, resident memory 357 MiB, thermal status 0, free storage about 76 GiB.

| Source | Capture duration | Bytes | Measured FPS |
| --- | ---: | ---: | ---: |
| Existing long recording | 1,500.036 s | 2,941,833,610 | 52.15 |
| Waiting recording B | 349.562 s | 685,619,716 | 39.69 when its processing began |
| Waiting recording C | 280.429 s | 550,076,773 | Not independently measured |

The long source is 1920×1080, approximately 15.69 Mbps including audio/container, with a 60 FPS target. The current camera test reports about 41.5 FPS. Neither is verified 60 FPS. The three sources total about 4.18 GB before temporary output/Gallery copies. At that bitrate, continuous capture adds roughly 7.06 GB per hour. Roughly 0.2× real-time branding cannot drain continuous recording; a 25-minute source is estimated to need roughly two hours plus pauses/retries/upload.

A separate suspension failure was reproduced: the enrolled app stopped reporting progress at 50%, and on return from suspension the no-progress guard threw before accepting newly advancing media. This occurred during diagnostic work; the original survived but that attempt restarted. The device was later measured at 9% battery, with an effective 10-second screen timeout. The exact OEM suspension mechanism is not established. No battery settings were changed; the user was asked to connect power and unlock the tablet.

The long recording's existing retry count increased from 1 to 2 because of that failure. Both waiting recordings remained at zero. Do not interpret this as a completed recovery run: all three real recordings remain queued, with their original byte sizes retained, zero uploaded bytes and no Drive objects yet. The local app and read-only backend checks agree on that. Historical 0.5.40 acceptance uploads delivered approximately 114–127 MB in 75–143 seconds including API/finalization overhead; no fresh isolated bandwidth benchmark was performed during this backlog.

## Changes made in this follow-up

- Camera mode selection immediately invalidates native approval, including switching away and back. Confirmation requires the same camera connection generation and exact mode as the successful test. The bridge passes the selected mode and unique test token; native code rejects stale-token clicks even when the mode matches. The WebView additionally requires a playable current test token; the disabled button has an explicit grey style. The operator must still review and confirm picture/sound.
- Admin finished local-only items are in a default-collapsed `Local-only videos (N)` group. Dates, recipients, sizes, recording links and applicable actions use the existing row renderer. Known short-clip policy notices are not mistaken for failures. Active processing, queued work, missing files and genuine errors stay outside history. Queued counts include `queued`; branded retries sort ahead of unbranded waiting work to reflect the existing scheduler.
- APK connection notice uses Android validated-network state and outcomes from existing API requests. No new polling loop or interval changes. Admin reuses its existing refresh and offline event; it explicitly says browser internet access is unverified when only a network link is known. The notice persists without repeated text updates and clears on verified server recovery. Neither notice changes recording, enrollment or upload state.
- Retry labels distinguish `Logo processing retry scheduled` from `Upload retry scheduled`.
- The branding guard now accepts successfully advancing media after suspension, with independent audio/video clocks. Repeated timestamps and returning without media progress still fail. It no longer rejects a successful resumed write solely because wall time elapsed. A native call that never returns remains outside Java's ability to interrupt safely.
- Approved opt-in USB live-logo prototype: offscreen EGL/OpenGL draws camera frames and the logo into the existing hardware encoder input Surface, preserving the current audio pipeline, selected dimensions/bitrate/target and texture timestamps. Initialization failure falls back to post-processing with a visible status. Mid-capture rendering failure is forwarded to the existing capture error path and cannot produce a verified branded marker. A SHA-256-bound MP4 UUID box records completed live branding; older files retain software processing. This does not speed up the already queued raw recordings.

## Verification

- Full web suite: **178 passed, 0 failed**. Final targeted web suite after the queue-count change: **11 passed**. Production Next.js build and TypeScript checking passed.
- Android standard and prototype builds passed. Standard lint: **0 errors, 45 warnings**.
- Initial focused native rerun: **11 passed**, covering GPU saved-file pixels, evidence integrity, native mode invalidation, connection classification, progress and queue recovery.
- WebView fixture on the HONOR: camera confirmation enabled for the playable matching test, became disabled/grey on selection change, stayed disabled when switched back without retesting, and did not send confirmation while disabled. Offline/server notices appeared and cleared while the fixture recording state stayed unchanged. **Passed**.
- Final native suite: **8 passed**, including the revised suspension guard, repeated-timestamp stall, API transport failure/recovery, native mode invalidation and reopening/reusing both live-branded camera files after process restart. A host Java check independently passed the revised guard behavior. After the final token check, five native mode/progress tests and four focused web tests passed again.
- Actual enrolled APK server interruption: temporarily routed its local port to an unavailable listener. It displayed `Internet available, but the application server cannot be reached. Retrying automatically.` Enrollment remained true. Restoring direct ADB reverse cleared the notice after an API response. Direct `tcp:3000 → tcp:3000` was restored and verified.
- Admin fixture render verifies a closed history group with dates/email/size/log link and a failure row outside it. Live Admin showed the real processing percentage and separate waiting items. No real local-only rows were available for an interactive history acceptance check.

### Real USB live-logo recordings

Two consecutive disposable clips were recorded in the separate unenrolled diagnostic package while the legacy app had pending work. No upload, database record or replay email was created for these clips.

| Clip | Capture | Validated video | Actual FPS | Bytes | Branding/reuse check |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 65.074 s | 64.796 s | 40.77 | 127,539,347 | 1.34 s |
| 2 | 65.086 s | 64.936 s | 42.27 | 127,600,095 | 2.04 s |

Both used 1920×1080, the unchanged 60 FPS target and 15,552,000 video bitrate setting, with the EMEET camera microphone. Both passed existing audio/video validation. A frame extracted from the saved first video visibly contains the logo; the synthetic saved-video test also verifies logo pixels and unchanged file bytes when branding is called again. A brief screen-lock interval was exercised during the camera test run; it is not a long-duration background guarantee.

### Failures and limitations recorded honestly

- First Android build attempt lacked `ANDROID_HOME`; setting the existing SDK path resolved it.
- An existing diagnostic test APK had a different signature. It was retained; a separately named signed test runner was installed instead. The enrolled application was not uninstalled or cleared.
- The first synthetic GPU pixel assertion failed. Its extracted file visibly contained the logo, and the focused rerun passed. A later repeat after a UI test failed the synthetic encoder drain deadline while the diagnostic app was backgrounded. These timing/background results are not counted as passes; they reinforce the need for sustained foreground/background acceptance before enabling the prototype by default.
- An activity-recreation test run stalled in the diagnostic environment and was stopped; it is not counted as a pass. The dedicated new WebView test and native mode-invalidation test passed independently.
- No full physical Wi-Fi loss test was done over the sole wireless-debugging connection. Internet-unavailable classification was tested with fixtures; actual server loss/restoration was tested on-device.
- Long 15/20/25-minute live-logo captures, sustained minimized/screen-off operation, forced EGL failure, low-power behavior, human audio-sync review and the client REDMI Pad 2 9.7 4G remain manual checks. REDMI and Samsung were unavailable. No claim of verified 60 FPS or production readiness is made.

## Build identity and installation

The enrolled local package `com.casabatik.recorder.dev` was updated with `adb install -r` to **0.5.41 / 47**, with live-logo mode **off**. Enrollment and the three saved recordings were verified afterward. Production package `com.casabatik.recorder` was not updated. Signing certificate SHA-256 matches the supplied original: `9956e3364853d3e048d6f95e46b23fc3baa6b0ef8eefb1e31e2705b9fba4e14a`.

Exports are outside the checkout in `C:/Users/ADMIN/Documents/projects/dinkvisionv3/DinkVision-APKs/`:

| APK | SHA-256 |
| --- | --- |
| `Dink-Vision-Recorder-0.5.41.apk` (normal server configuration) | `e7061e199e3fe53764c111f0b5670faa45a5d6b2a9c313134ac7c833600b5f77` |
| `Dink-Vision-Recorder-0.5.41-local.apk` (installed, live logo off) | `e3b9a16caeb42797102635be61861e44afc3ae5b0cff22cdcaad1d1f68b300b0` |
| `Dink-Vision-Recorder-0.5.41-local-live-logo-prototype.apk` (opt-in, not installed over enrollment) | `47f2dd697b2b884b45e82b2c8f1864a8ab5a3ffa80c7c300624e59a524419fae` |

The opt-in build uses `:app:assembleDebugLocal -PliveUsbLogo`. Default builds set `LIVE_USB_LOGO=false`. Standard Gradle outputs were restored after prototype testing. The diagnostic package remains separate; never use it to replace enrollment.

## Charging follow-up verification

After the user connected power, AC charging and awake state were verified (battery initially 8%, rising to 9%). No power settings were changed. The existing installed 0.5.41 build was used; no additional APK or code change was needed for this follow-up.

The separate diagnostic package repeated two consecutive 65-second EMEET captures. The screen was deliberately locked during the first clip and remained fully asleep through the second. During the second capture, the tablet's local-server forwarding was directed to an unavailable listener for 20 seconds and then restored in a `finally` block. Both captures passed existing audio/video validation, retained verified live-logo evidence, and reused their saved bytes without software re-encoding. No uploads or replay emails were created for these disposable clips.

| Charging/locked clip | Capture | Validated video | Actual FPS | Bytes | Branding/reuse check |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 65.029 s | 64.797 s | 36.19 | 127,285,471 | 2.05 s |
| 2 | 65.093 s | 64.925 s | 43.22 | 127,541,817 | 1.97 s |

The EMEET camera microphone remained selected. Resolution, bitrate and the 60 FPS target were unchanged. The instrumented camera test passed. This verifies these short captures, not 15/20/25-minute or REDMI operation.

While the screen was asleep, the diagnostic camera process remained active (sampled at 231% CPU), while the enrolled software-branding process was suspended (0% CPU). The enrolled app's diagnostics showed a 285-second gap: encoded frame count advanced from 830 at elapsed 90.38 seconds to 834 at elapsed 375.83 seconds after wake, with no new `start` entry and no stall exception. The revised guard resumed the same attempt. Its retry count remained 2; both waiting videos remained at 0. Enrollment and local-server connection remained valid. Direct ADB reverse `tcp:3000 → tcp:3000` was restored and verified.

Evidence: `.local/honor-followup/charging-camera-tests.txt` and `charging-camera-results.txt`, plus the enrolled app's bounded branding diagnostic log. The real three-video backlog remains unfinished; charging does not by itself prevent HONOR from suspending the legacy software-processing worker while asleep.

## Changed-file inventory

Existing files patched:

- `android/app/build.gradle`, `android/recorder-release.json`
- `android/app/src/main/assets/app.js`, `index.html`, `style.css`
- `android/app/src/main/java/com/casabatik/recorder/Api.java`, `Engine.java`, `MainActivity.java`, `UvcCameraRecorder.java`, `VideoBranding.java`, `BrandingProgress.java`
- `android/third_party/uvcandroid/src/com/herohan/uvcapp/VideoCapture.java`
- `components/browser-tablets-admin.tsx`
- `lib/device-queue-order.ts`, `lib/local-video-status.ts`
- `android/app/src/androidTest/java/com/casabatik/recorder/CameraTestRecoveryTest.java`, `BrandingProgressTest.java`
- `tests/local-video-status.test.ts`

New files:

- `android/app/src/main/java/com/casabatik/recorder/ConnectionNotice.java`, `LiveLogoProcessor.java`, `LiveLogoEvidence.java`
- `android/app/src/androidTest/java/com/casabatik/recorder/ConnectionNoticeTest.java`, `CameraConfirmationUiTest.java`, `LiveLogoProcessorTest.java`, `LiveLogoCameraTest.java`
- `tests/honor-followup.test.ts`
- This report and `docs/testing/HONOR_Live_Logo_Proposal.md` (approved before prototype implementation).

Detailed commands, build/test logs, measurements, baseline hashes and read-only reconciliation results are retained under ignored `.local/honor-followup/`. No unresolved external source-edit overlap was observed.
