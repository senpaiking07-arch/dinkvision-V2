# Android recorder workflow — 0.5.31

## Court tester: setup and camera check

1. Install the APK as an update over the existing app. Do not uninstall it or clear its data while recordings are waiting: enrollment and original footage are stored privately in the app.
2. Enroll only if the tablet is not already enrolled. The administrator assigns its court. Connect the USB camera and grant camera, microphone, and any USB access requested by Android.
3. Record a camera test. The app captures enough source footage to produce a three-second branded preview.
4. Play the entire preview with the volume on. If picture and sound are clear, tap **I can see and hear the test**. If either is wrong, tap **Record another test**.
5. Camera confirmation must be saved by the server before player recording becomes available. A camera configuration change invalidates an older test. A live match blocks a test; an older saved video uploading in the background does not.
6. If saving confirmation fails because of connection loss, reconnect and confirm the same clip again. If settings changed, **Record another test** fetches the current configuration and starts a new check.

## Players: recording a match

1. Tap the welcome screen, manually enter one to four Gmail addresses, and add each address.
2. Review the court and every recipient before confirming the recording. The recipient list is saved with that session.
3. The countdown prepares capture. The recording timer runs from the actual recording start.
4. Stop once, or let the configured duration finish. Wait until the app confirms the original video is saved locally.
5. The capture slot is then free for the next group. Previous video validation, logo processing, and upload continue separately.

## Background work and administrator monitoring

| Stage | What it means | Next step |
| --- | --- | --- |
| Saved locally / adding logo | The original remains on the tablet. Media validation and logo processing happen before upload. | Keep the app installed and the device powered. |
| Pending | The validated, branded file is waiting for its turn in the tenant upload queue. | No player action is required. |
| Uploading | The tablet transfers its file to Google Drive. Interrupted transfers resume from the server's acknowledged offset. | Monitor progress in Admin. |
| Retrying | A temporary failure has scheduled another attempt. Network retries use backoff and stop after eight failed attempts. | Restore connectivity; if attempts are exhausted, use the failed video's action. |
| Failed, logo/validation error | Media processing could not complete. Better internet does not repair invalid media timing. | Read the exact per-video error. **Retry processing** asks the original tablet to revalidate and process its local file; it does not bypass validation or guarantee repair. |
| Failed, upload error | Processing completed but cloud transfer or confirmation failed. | **Retry upload** asks the original tablet to resume. |
| Uploaded / complete | The server has confirmed completion; the app can release its local backup. | Check replay-email status separately. Upload completion does not itself prove an email was delivered. |
| Email failed | The Drive video exists, but replay email delivery failed. | Retry the email in Admin. An uncertain email delivery requires review rather than an automatic resend. |

Admin shows each failed video even when it is older than the first four queue entries. It shows its reported logo state and error, and uses **Retry processing** or **Retry upload** according to the stage reached. An offline tablet cannot execute a queued request until it reconnects. A server queue entry is not a remote copy of the original footage.

Android saves failed reports durably and sends them again after reconnecting. A stale server poll cannot silently reset an acknowledged failure. A newer explicit administrator retry request grants another processing/upload attempt.

Clips under one minute follow the existing local-only policy and are not uploaded or emailed. Local originals are not automatically added to Android Gallery.

## Known court footage requiring inspection

The configured production database was inspected read-only on 2026-11-01. Videos **0c99e1e5** and **332b40d0** reported:

- `Saved audio and video do not end together. The recording stays on this device.`
- Branding state `failed`, retry count `8`, and a local copy reported available.
- No immutable upload file had been registered, so these failures occurred before cloud upload. They are not explained by poor internet.

The original files have not been obtained from the court tablet. These records do not establish whether the timing mismatch is in the source or generated logo output, or how large the mismatch is. Version 0.5.31 keeps the validation gate, reports the measured end-time difference on future failures, and stops retrying a timing failure as though it were a network fault.

The court tester must preserve the app data and provide a copy of an affected original for media analysis. The admin website cannot download an unuploaded file stored privately on a remote tablet. If the installed build is debuggable, the tester can copy the original through Android Studio Device Explorer under `com.casabatik.recorder/files/recordings/`; use the full session UUID from Admin and copy the file without editing or deleting it. If Device Explorer access is unavailable, a device-side export path is still required.

## Verification boundaries

Automated database tests cover confirmation during an older upload, rejection during active capture or stale configuration, and retry of a local validation failure before an upload file exists. Android emulator tests cover camera-test recovery, durable failed reports, queue isolation, file preservation, and the player WebView checks.

An emulator does not validate the court's USB camera, power supply, cable, sustained capture performance, or these original videos. Those remain physical-device checks.

Checks completed on 2026-11-01: all 124 tests in the full Node/database suite passed. A total of 38 selected Android instrumentation tests passed on the API 35 Pixel Tablet emulator, including logo processing of a 65-second fixture, three-second preview duration, audio-tail validation, upload resume, recovery, and the player UI. The upload-worker timing-failure test confirms that validation stops after one attempt, reports a media error, and preserves every byte of the original. Next.js production build and Android `assembleDebug` / `lintDebug` passed. Version 0.5.31 uses version code 37. The APK is a debug-signed test build; these checks do not establish production stability on the court hardware.

## Publication record

Commit `ad6f6f2` was pushed and the two 2026-11-01 database-function migrations were applied before the user explicitly required a fresh instruction for every GitHub upload. Vercel reported that automatic deployment as failed, so the corresponding web changes were not confirmed live. Further local test additions and diagnostic-message adjustments remain unpushed. No additional GitHub upload or deployment is authorized until the user requests it.
