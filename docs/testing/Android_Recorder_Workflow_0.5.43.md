# Live watermark verification on the HONOR

## Build and paths

DinkVision 0.5.43 (49) was installed over the enrolled local recorder, com.casabatik.recorder.dev, with the matching signing certificate. Wireless ADB forwarded tablet port 3000 to the local Next server. The server used hosted Supabase project zjfeavhxqunlqdriroxg. Testing used Honorable 2 on Renzo tablet test. Ordinary recorder operations created the three approved test records. No migration was necessary.

The default USB and Camera2 paths send camera frames through an offscreen SurfaceTexture/EGL compositor into the encoder. A single GPU texture contains the same transparent PNG as public/dink-vision-logo.png. The compositor blends premultiplied alpha, compensates the logo for Camera2 playback rotation, and forwards the camera presentation timestamp. The USB muxer retains the encoded timestamp. The capture and audio services run independently of the WebView. New sessions record that live evidence is required before capture starts. After the MP4 is drained and finalized, the recorder checks the SHA-256-bound live marker and validates the media including audio before reporting branding complete. Recovery rejects a new file without valid evidence. Previously queued raw recordings retain software branding. Upload retries reuse the finished file. The preflight reserves space for one new MP4 plus overhead.

## Physical test results

HONOR YAG-W09 and EMEET SmartCam S600. The approved final camera check had 3.40 seconds of picture, 3.15 seconds of recorded audio and a 3.42-second playback timeline. The user reviewed it with sound. All three longer clips used 1920×1080 at a 60 FPS target. Android reported the EMEET microphone.

| Match | Video / audio duration | Encoded frames | Actual FPS | Longest video frame interval | A/V endpoint difference | MP4 bytes | Stop to finalized |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 67.345 / 67.184 s | 2,692 | 39.97 | 53 ms | 13 ms | 131,962,797 | 3.07 s |
| 2 | 66.492 / 66.490 s | 2,650 | 39.85 | 136 ms | 173 ms | 130,434,258 | 2.94 s |
| 3 | 66.834 / 66.721 s | 2,670 | 39.95 | 44 ms | 28 ms | 130,888,025 | 3.16 s |

Finalization timing is measured from the stop request to the first observation of the completed local state. A/V endpoints include the MP4 track offsets. These are timeline measurements; a timed audiovisual stimulus would be needed to measure lip sync at arbitrary points. The files contain 8,012 encoded frames in total. Encoded sample counts and longest frame intervals were measured directly. The camera did not expose an independent count of pre-render frames, so losses inside the camera cannot be separated from downstream drops.

All three downloaded Drive MP4s matched their respective private tablet files byte for byte (SHA-256). Decoded frames at 0.1 seconds, halfway through, and about 0.22 seconds before the end matched the upright logo template at the intended lower-right coordinates. Approximately 98% of opaque template pixels met the color comparison tolerance. The original alpha texture is used in the compositor. Extracted frames, file hashes and measurements are in the ignored .local/live43 directory.

The three final MP4s total 393,285,080 bytes. All three entered the local queue with completed branding before any upload; no software re-encode ran. The first match started during the prior legacy upload. Match 3 started while match 1 was uploading and match 2 was waiting. Match 2 continued after switching to the home screen and during a measured 36-second screen lock.

The local app was force-stopped and cold-started after match 3 finalized. It recovered match 2 and the waiting match 3 with their original IDs and completed branding. Match 2 resumed at a Drive-acknowledged 96,468,992 bytes. For match 3, a local proxy withheld an upload-status reply after Drive acknowledged 4 MiB. The queue reported an upload retry, resumed from that offset and finished the same file. The post-recovery acknowledged transfer rate averaged 15.2 Mbps over the measured interval. Upload throughput on this network can still accumulate a queue even without a branding backlog.

The database reported all three recording sessions and files ready, branding complete at 100%, uploaded byte counts equal to the file sizes, and all three replay email jobs sent. The Admin stage formatter produced “Uploaded · private upload copy released” for each reconciled row. The APK released its private copies after upload confirmation. Export and deletion rules, ownership, upload ordering and worker limits were preserved. No deployment, commit or push was performed.

## Files changed in this patch

- android/recorder-release.json and android/app/build.gradle — version and removal of the optional live-logo build flag.
- android/app/src/main/java/com/casabatik/recorder/LiveLogoProcessor.java and LiveLogoEvidence.java — watermark rendering for both camera paths, orientation, timestamps and verification.
- android/app/src/main/java/com/casabatik/recorder/DeviceCameraRecorder.java and UvcCameraRecorder.java — camera lifecycles, full short test and renderer failure handling.
- android/third_party/uvcandroid/src/com/herohan/uvcapp/VideoCapture.java — fail capture if watermark setup fails and retain encoder timestamps.
- android/app/src/main/java/com/casabatik/recorder/Engine.java — validation, queue journal, restart recovery, storage budget and camera-check flow.
- lib/local-video-status.ts and tests/local-video-status.test.ts — preserve confirmed upload status alongside the private-copy cleanup detail.
- android/app/src/androidTest/java/com/casabatik/recorder/LiveLogoCameraTest.java and RecorderTest.java — focused hardware scenarios, storage preflight and welcome-screen test expectations.

## USB interruption, Camera2, and remaining checks

The first diagnostic unplug window elapsed with the camera still attached. During the repeated test the operator physically disconnected the EMEET. Android reported that the USB camera closed unexpectedly, retained a 35,644,881-byte private partial file, and the disposable diagnostic made no upload. The same test then recorded with the built-in camera and tablet microphone. The 1920×1080 Camera2 MP4 contained a 90-degree playback rotation, 147 video samples, 29.50 actual FPS, 4.982 seconds of video and 4.992 seconds of audio. The A/V endpoints were 43 ms apart. After applying the MP4 display rotation, the logo was upright at bottom-right at all three sample points. Approximately 97% of opaque logo pixels matched the reference tolerance.

The final project test run passed 179 of 179 tests. Four targeted native tests passed for changed/truncated evidence, one-file storage preflight, validated legacy branding, and preserving an older original when processing is paused. The physical unplug/built-in test and the player UI/foreground service regression passed separately. The broad native sequence was interrupted during testing and is not counted as a full suite pass.

No REDMI Pad 2 was available. Sustained 15–25-minute live captures, thermal endurance, and physical microphone unplug/fallback while the same USB video feed continues were not measured. The hardware did not report an independent source-frame count. The local API-connection outage was controlled after a Drive-acknowledged chunk; it did not disconnect the entire venue Wi-Fi network.

External APK SHA-256 hashes:

- Dink-Vision-Recorder-0.5.43-local.apk (installed) — 2ab529c26f77e594e9a28bfc63de898c46322f51fa8e1cd9dafe4b5a4aa92135
- Dink-Vision-Recorder-0.5.43.apk (standard server) — 88e7bc18d8c14c8a7f69994a9ad38d4888901e8d6749899a82c7ab724e90bc96

## Connected player acceptance, November 4

On a cold launch with the local API unreachable, Honorable 2 retained enrollment and offered Retry. Restoring the ADB reverse connection and tapping Retry recovered the existing registration. Start required a new camera check. The operator played the 3.41-second check with sound and confirmed it. The camera test measured 38.9 FPS at a 60 FPS target.

Using the installed player controls, the tester opened Saved videos and returned, submitted an empty player form, entered the authorized recipient with the Android keyboard, reviewed the confirmation, edited it, and started recording. The validation message and keyboard left the heading, input, action, and footer rectangles unchanged. Each repeated Start tap was blocked during startup. The first saved replay had a local player source and showed “Waiting to upload.” The second match was recording while the first uploaded at 82%. Admin showed the court recording and displayed the upload in Recording logs.

Both first replays were 1920×1080. They contained 64.84 and 64.36 seconds of video at 39.97 and 39.98 FPS. Each had a matching logo near the beginning, middle and end. The audio and video endpoints differed by 14 and 22 ms. The second transfer retried once after the API returned “Prepare the upload before checking progress.” The original stayed on the tablet during backoff. The completed Drive download had the same SHA-256 as that private file.

The API had accepted delayed finalization snapshots even after the upload worker claimed the row. The local route now applies a finished-logo “saved locally” snapshot only while the database row is still idle or saved locally. The condition is applied in the database update itself. The failing request did not record which precondition failed, so retrospective attribution of that specific retry remains uncertain.

After the local API change, a third 64.91-second match recorded at 40.00 FPS and uploaded without a retry. Its downloaded SHA-256 matched the tablet file, with the logo detected at all three sample points. The three database sessions and files were ready, with complete branding, full uploaded byte counts, released private copies and sent delivery jobs. The signed-in Admin Recording logs showed all three as ready. The tablet returned to Welcome with camera approval, zero queued videos and an empty private recordings directory. TypeScript passed and all 180 project tests passed, including the new delayed-save regression. Android system notification overlays, venue-wide network loss, low-storage behavior and sustained full-length captures still need physical acceptance.
