# Android 0.5.29 physical checks — October 30, 2026

Test device: Samsung SM-A226B (Android 13) with an EMEET SmartCam C60E 4K connected over USB/UVC. The enrolled venue configured a five-minute recording limit. Recipient details, enrollment codes, and session identifiers are omitted.

| Check | Result | Evidence |
| --- | --- | --- |
| Camera setup and three-second preview | Passed | EMEET preview saved 3.137 s of video and 3.029 s of audio. The operator confirmed the picture and sound. |
| Full configured recording | Passed | The USB capture ran from 08:26:35 to 08:31:38. Branded output validated at 300.113 s and 228,785,259 bytes. |
| Recording with screen off | Passed | With Android reporting `Dozing`, the source file grew from 144,342,671 to 176,341,083 bytes over roughly 30 seconds, and the foreground recorder service remained active. |
| Upload interrupted by app stop | Passed | The app was force-stopped at 16% upload; the 218 MB local file remained. Reopening resumed upload and later reached 100%. |
| Server error and automatic retry | Recovered | The server returned HTTP 500 near 91%; the local queue recorded five retries. It eventually reached `uploaded`, and the local copy was removed only after server confirmation. This transient server error remains a backend reliability signal to monitor. |
| USB camera unplugged during recording | Passed | The app stopped the capture, reported the interruption, and retained a 21 MB partial file without emailing it. The EMEET was reconnected. |
| Recover saved video control | Passed | Version 0.5.29 showed a recovery button and confirmation modal for the failed local capture. Recovery validated and branded 29.077 s of footage. The server classified it as `local_only`, so it was not uploaded or emailed. |
| Build and focused regression checks | Passed | `assembleDebug`, `assembleDebugAndroidTest`, `lintDebug`, the three-second preview instrumentation test, and the local recovery action instrumentation test passed. |

The final installed package reports version name `0.5.29` and version code `35`. The debug APK is exported locally to `artifacts/Dink-Vision-Recorder-0.5.29.apk`; its SHA-256 is recorded beside it. The prior enrollment and the locally held short clip survived in-place APK updates.

This check does not establish production release readiness for 15-, 20-, or 25-minute sessions because the venue limit was five minutes. Email inbox delivery and playback of the uploaded full-length replay were not independently confirmed. The package is debug-signed; production signing remains a separate release step.
