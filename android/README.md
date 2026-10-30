# Dink Vision Android recorder

This is an installable Android USB/built-in camera recorder, using the existing hosted admin,
tablet enrollment, Drive upload, email delivery, and retention APIs. It does not
replace the Vercel application and does not require a venue PC. The Android
device must reach the hosted backend.

## Install and configure

1. Transfer `Dink-Vision-Recorder-0.5.30.apk` to a **64-bit Android 8 or newer** device.
   Open it and allow installation from that file source when Android asks.
   This is a debug-signed testing build, not a Play Store release.
2. In the hosted admin's **Devices & cameras**, add/edit the device, assign its
   court, and generate an enrollment code. Camera mode is selected on the
   enrolled tablet:
   **Wired USB / built-in Android camera** uses an attached standards-based
     UVC camera. It first uses Android Camera2 when the manufacturer exposes the
     camera there, then falls back to the APK's direct USB-host/UVC driver. With
     no USB camera attached it uses the rear camera. The tablet microphone supplies audio.
   Standard UVC models such as compatible EMEET cameras are the intended external cameras.
3. Open the APK and enter the enrollment code once. Allow camera and microphone
   permissions. The saved USB/built-in setup is
   tested automatically and does not require another enrollment code.
4. On failure, use **Re-enroll device** to replace the enrollment, or tap the
   player screen to reopen incomplete camera setup. Camera
   configuration changes are blocked during active
   recording/upload; pending local footage must be recovered before retesting.
5. Tap anywhere on the welcome screen, enter at least one player email on either team, add any optional recipients, confirm them, and record a short match.
   Stop, wait for upload confirmation, and check playback and email. Test a
   full-length match on the actual tablet before venue use.

Keep the tablet powered and the app open during initial testing. Its foreground
service can continue recording/uploading when the player screen is backgrounded;
force-stop, reboot, process termination, and manufacturer battery restrictions
can interrupt it. Do not clear app data or uninstall while a video is pending.
If an interrupted recording leaves a local video, **Recover saved video** appears
on the welcome screen. It checks that file before saving it or retrying upload.
Transient upload failures retry automatically and the Android notification shows
when a retry is scheduled. Only discard a failed local recording when its loss
is acceptable. Uploading sessions remain protected.
Recordings shorter than one minute are not uploaded. They remain in the APK’s
private directory at
`/data/user/0/com.casabatik.recorder/files/recordings/`. Offline and failed
uploads stay there too. Clearing app data or uninstalling the APK deletes them.
The recorder checks that audio reaches the final picture before upload; files
with a missing audio tail remain local for review or recovery.
When several tablets finish together, the venue uploads one saved video at a
time. Waiting devices show the active upload and its progress. A failed first
upload pauses the queue until that same device successfully retries, so later
videos never skip ahead or lose their local copy. An administrator can cancel a
stuck upload to release the next device without deleting the original local
video. Recovering that video later places it at the end of the queue.

## Scope and limitations

- This build records a standards-based UVC/OTG camera, the Android device's rear
  camera and microphone. UVC support still depends
  on the camera's advertised formats, a working OTG adapter, and sufficient USB
  power. Proprietary non-UVC and network cameras are unsupported. iOS, proprietary cloud-only cameras, ONVIF discovery,
  automatic IP discovery, and remote PTZ are not added here.
- Android-device capture uses Camera2/MediaRecorder when available and the direct
  USB/UVC driver otherwise. Track durations and packet timelines are validated
  before upload, including recovery. An invalid file remains local.
  Tablet CPU, battery,
  temperature, and Wi-Fi affect performance. This first build is not a guarantee
  of full-duration performance on untested hardware.
- The enrolled tablet retrieves only its assigned configuration over HTTPS.
  API cookies are encrypted with Android Keystore. Video files
  stay in app-private storage until the backend confirms upload; backups and
  device transfer are disabled. Internet API and Drive traffic use HTTPS.
- The backend origin is injected from `APP_ORIGIN` in the repository `.env` or
  the Android build environment. No service
  role key, Google secret, camera password, or admin password is bundled.
- The backend models the USB/built-in APK camera as a managed Android recorder source.
  Apply `202610060015_admin_rtsp_setup.sql` and
  `202610070017_permanent_device_removal.sql` through
  `202610100025_camera_orientation.sql`, then deploy the web changes before
  installing APK 0.5.30. Enrollment, authorization, upload, and email must still
  be tested with the venue's real account/device.

## Build

Install JDK 17 and Android SDK platform 36. Set `ANDROID_HOME`, or put the local
SDK location in a gitignored `local.properties`. From this directory:

```powershell
.\gradlew.bat :app:assembleDebug :app:lintDebug
```

APK: `app/build/outputs/apk/debug/app-debug.apk`. Every `assembleDebug` build,
including Android Studio's **Build APK(s)** action, copies that exact APK to
`../Dink-Vision-Recorder-0.5.30.apk` and
`../artifacts/Dink-Vision-Recorder-0.5.30.apk`. It contains arm64-v8a and x86_64
native libraries. Gradle and native dependencies are pinned. The debug signing
key lives in the developer's Android profile, not in this repository.

For a production build, keep the keystore and passwords outside the repository,
set all four variables below, and build the release bundle. Release shrinking and
resource optimization are enabled; without all four values Gradle deliberately
leaves release outputs unsigned.

```powershell
$env:ANDROID_RELEASE_KEYSTORE = 'C:\secure\dinkvision-upload.jks'
$env:ANDROID_RELEASE_STORE_PASSWORD = '<store password>'
$env:ANDROID_RELEASE_KEY_ALIAS = '<key alias>'
$env:ANDROID_RELEASE_KEY_PASSWORD = '<key password>'
.\gradlew.bat :app:bundleRelease :app:lintRelease
```

Back up the keystore and credentials separately. The signed bundle is written to
`app/build/outputs/bundle/release/app-release.aab`; store distribution remains a
manual release step.

Open the `android` directory itself as the Android Studio project. Select the
automatically generated **app** Android run configuration and use **Run app**
to rebuild and reinstall the current source on the selected emulator. Opening
the repository root creates a non-Android project and can leave an older APK on
the emulator.

## Android integration tests

The Android suite uses bundled media fixtures and the emulator's built-in camera.
It does not require or exercise an RTSP/Tapo source and does not send a real
recording or email. Physical UVC/EMEET behavior still requires a real Android USB
host device and data-capable OTG adapter.

```powershell
.\gradlew.bat :app:connectedDebugAndroidTest
```

Tests cover media timing/validation, stop, output decoding, Android camera source
selection, encrypted persistence, corrupt-file rejection, player asset loading,
and foreground-service startup. Physical UVC/EMEET recording, arm64 hardware performance,
long captures, upload interruption/recovery, and
actual Drive/email delivery remain device acceptance tests.

## Open-source components

JavaCV/JavaCPP 1.5.12, FFmpeg 7.1.1-1.5.12 non-GPL Android classifiers,
UVCAndroid 1.0.13, AndroidX WebKit 1.14.0 and Activity 1.10.1. License texts and source links are packaged in
`app/src/main/assets/licenses`. FFmpeg libraries are dynamically linked; replacing
their native JAR inputs and rebuilding/re-signing the APK supports modifications
to those libraries. Preserve the included license notices when distributing.

## Upgrade from 0.1.0

Install over the existing APK to keep enrollment and pending footage. After the
device is enrolled, connect the wired USB camera (or use the built-in camera),
then run its camera test. The
browser camera workflow remains available for browser-based tablets.
