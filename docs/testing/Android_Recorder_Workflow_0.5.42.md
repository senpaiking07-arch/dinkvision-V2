# Android recorder 0.5.42 verification

The local build is version 0.5.42 (48), package `com.casabatik.recorder.dev`. The signed APK was exported to the sibling DinkVision-APKs directory. Its SHA-256 is `203c3c2e0d0b63bffae6d624cff88a18081e33f4e5375e1d92f70a5f9c9b92aa`.

## Changes since the 0.5.41 working tree

| Files | Change |
| --- | --- |
| android/app/src/main/assets/index.html, app.js, style.css, kiosk-theme.css | Responsive two-line welcome headline, static touch icon and start instruction, independent footer controls, installed version credit, persistent connection status and manual retry. Reused existing artwork and logo. |
| android/app/src/main/java/com/casabatik/recorder/Api.java | Require a successful enrollment response with a valid replacement device credential before returning enrollment success. |
| android/app/src/main/java/com/casabatik/recorder/Engine.java and MainActivity.java | Validate the tablet-state response before replacing the cached assignment. Derive failure and recovery from registration checks and retry using the existing executor and stored credential. |
| android/recorder-release.json | Version 0.5.42, build 48. |
| android/app/src/androidTest/java/com/casabatik/recorder/EnrollmentConnectionTest.java and tests/branding.test.ts | Regression coverage for malformed state, incomplete enrollment and welcome markup. |

The single-use code exchange, Android Keystore-backed vault, kiosk token lookup, active device check, mandatory camera review, media processing and upload queue predate this patch. The server already distinguishes an unavailable database (503) from a successful lookup with no active registration. Code inspection identified two client-side failures: incomplete JSON could clear the cached owner ID, and an unrelated successful HTTP request could hide a failed registration check. Both paths are covered by the client changes. No database schema change was needed.

## Verification

- All 178 project tests passed on the final run. Eight enrollment and connection tests passed in the separate diagnostic package on the HONOR. The fixtures exercised repeated timeouts, process reload, malformed responses, explicit revocation and protection against invalid credential replacement.
- Rendered welcome layouts at 1280×800, 800×1280, 360×640, 640×320 and 320×480. Checked text and button bounds, footer separation, background tap, guarded camera setup, Saved videos, Re-enroll and Retry connection. Screenshots are in the ignored .local/welcome42 directory.
- The enrolled local package had already been removed before installation. Verified the signing certificate against the previous local APK export, installed the new APK, and enrolled the replacement setup with a fresh one-time code. The supplied previous code was rejected as expected.
- The installed APK showed the Renzo tablet test assignment for Honorable 2, with camera approval pending and an empty queue. A read-only check of hosted project zjfeavhxqunlqdriroxg found exactly one Admin row linked to the new kiosk. The Android app did not create an additional Admin device.
- Force-stopped and relaunched during a controlled server outage. The saved credential survived. The welcome screen displayed the server-unavailable indicator and manual retry, and no first-time enrollment modal opened. Restored port 3000 and pressed Retry. The same court returned and the indicator cleared.
- Reinstalled the signed APK over that enrolled installation using adb install -r. The same enrollment and court returned without a code and camera approval was still required.
- After the controlled reboot, restored wireless ADB and port 3000 and cold-launched the APK. It authenticated automatically, showed Renzo tablet test with no enrollment prompt or connection warning, and still required camera approval. A read-only Admin check confirmed the identical device and kiosk IDs and exactly one linked registration. The new registration has no footage, so ownership continuity for the user's deleted registration could not be tested on this installation.
