# Android recorder 0.5.32 — local test candidate

Date: 2026-11-01. Version code: 38. This is a debug-signed build. No GitHub upload, web deployment, or production database change is authorized for this local update.

## Recording and recovery

1. Install as an update over the existing app. Do not uninstall or clear data while videos are pending: the enrollment and originals are private app data.
2. Enroll if required, connect the camera, grant Android permissions and run the three-second camera test. Play the entire clip and confirm picture and sound. The app saves confirmation before allowing a match.
3. Tap anywhere on the welcome surface, manually add one to four Gmail addresses, review recipients and confirm. Setup opens instead if the device is not ready. The header shows actual camera state and the assigned court, not labels embedded in the artwork.
4. Stop recording once, or let its configured limit finish. Capture and upload are separate: an earlier saved video can process/upload while the next group prepares a match.
5. For an unsent recording, choose **Saved videos** at the bottom left of the welcome screen, or **Recover saved video** in the error message. Failed entries appear first. Use Previous/Next to inspect each local file.
6. Play the preview. **Details** shows its failure. A damaged original may not preview; it can still be exported for diagnosis.
7. **Save to device** copies the file without moving or deleting the app's original. On Android 10+ it publishes the finished copy to `Movies/DinkVision`, visible through Gallery or Files. Android 8/9 uses Android's save picker. Saving again deliberately creates another copy; it does not claim an earlier export contains later processing changes.
8. Network failures use backoff and stop after eight failed attempts. **Retry upload** grants a new attempt for the same session and recipients. For logo/validation failures, **Retry processing** rechecks the original; it does not repair corruption or bypass media validation. A validation failure can stop immediately rather than exhaust network retries.
9. Upload completion requires server confirmation before the existing local-cleanup path releases the private backup. A separately exported device copy is independent. Check replay-email status separately from upload completion.

The saved library is scoped to the verified enrolled device. After upgrading an older installation, connect once so the app can persist that identity; subsequent offline launches can list and export its files. Explicitly disabled/revoked and other-device entries are excluded. There is no video-delete button in this library.

The website cannot retrieve an unuploaded file from a remote tablet. Court staff must update that original tablet, save the affected original, and provide the exported file for analysis. Known videos `0c99e1e5` and `332b40d0` previously reported audio/video end-time mismatches before cloud upload; their original files are still needed. Repeated upload requests alone cannot fix those samples.

## Admin recording names and logs

Device queue entries show the venue date/time and first saved recipient, with `+N more` for groups. Long addresses are shortened visually; the full label is available in the title/accessibility label and the linked log contains all recipients. Session IDs remain internal and searchable in Recording logs. Clicking a queue label opens that exact log, including a session older than the latest 100. The lookup retains existing administrator authorization and database isolation.

The shared Android kiosk library uses date/metadata and internal short references rather than displaying prior groups' Gmail addresses. Drive filenames and existing session identities are unchanged.

## Theme and asset provenance

The APK uses separate `public/Kiosk-Background-Tablet.png` and `public/Kiosk-Background-Phone.png` source assets, with byte-identical packaged copies enforced by Gradle and tests. Website pages remain unchanged by the theme. The assets have no embedded logo, court, status, or text. The live UI uses condensed sport headings, navy fields/panels, teal actions, an alternate stop action, and a transparent ripple. Compact layouts retain usable controls rather than enabling document scrolling.

The header and video watermark still load byte-identical copies of `public/dink-vision-logo.png`. The header applies a display-only color mapping for contrast on navy; the source and watermark are not recolored or replaced. The launcher/startup retain the previously selected square asset. Barlow Condensed Bold Italic is packaged for offline use with its SIL Open Font License in `assets/fonts/`.

The background variation was produced with the built-in image-generation tool. Final landscape prompt:

> Create one landscape 16:10 background-only raster asset for a premium DinkVision pickleball recording tablet app, using this image only as a palette and sporting energy reference. It must be a clearly different original composition, not a copy: deep midnight navy (#041d38) with subtle print grain, an elegant large three-dimensional neon lime perforated pickleball tucked into the far lower right edge occupying only the rightmost 30%, surrounded by subtle thin teal orbital arcs and a trail of tiny teal halftone dots. Use sweeping curved court motion lines along the very bottom and right edges rather than the reference's straight diagonal intersecting lines. Upper left through middle 65% and the entire top edge must remain nearly empty dark navy negative space so real app text and controls can be drawn there. Low visual noise, sophisticated sports broadcast identity, teal #09d6c2 and electric lime #d7ff42 accents. No text, no letters, no words, no branding, no logo, no icon, no buttons, no status badge, no UI, no watermark. Maintain very dark unobstructed left and central space. Render polished textured sport artwork ready to ship.

Final portrait prompt, using the landscape output as reference:

> Create a matching portrait 9:16 phone background-only asset in exactly this sports illustration style and palette, recomposed for a narrow vertical screen. Deep midnight navy, subtle fine print grain, teal motion arcs and lime perforated pickleball tucked into the bottom right corner, the ball only occupies the bottom 25% of the picture. Top 72% is empty nearly uniform dark navy negative space for live app text. Bottom court motion line curves around the ball. No text, logos, letters, UI, status, watermarks or icons. Crisp sophisticated textured sports broadcast art matching the provided landscape background. Preserve navy #041d38, teal #09d6c2, lime #d7ff42.

## Verification boundaries

The API 35 Pixel Tablet emulator exercises layout sizes 320×480, 360×640, 568×320, 800×1280, 1280×800 and 2560×1600. Checks cover saved-video controls, no document overflow, phone/tablet artwork selection, welcome, four-recipient form, confirmation, recording controls, camera review, setup modals, and real offline font loading. Screenshots use synthetic fixtures, with no real enrollment, footage deletion, or replay emails.

Real MediaStore tests verify byte-exact copies, source preservation, a fresh second export, incomplete-output cleanup and published-copy preservation. Other tests cover ownership, playback ranges and same-session retry. The web suite verifies compact recording labels and older-log links.

Final checks on 2026-11-01: **129/129 application tests and 44/44 selected Android instrumentation tests passed**, with no skipped tests. After the keyboard-placement refinement and removal of obsolete artwork, the 11 affected Android UI/recorder tests and seven targeted asset/camera-flow tests passed again. Next.js production build, Android `assembleDebug`, and `lintDebug` passed (lint: zero errors, 27 warnings). The resulting 0.5.32/code-38 APK was installed and launched on the API 35 emulator. A separate real keyboard check on its 2560×1600 display confirmed `mInputShown=true` and identical UIAutomator bounds for the enrollment heading, copy, and input before/after opening the keyboard. The permanently higher panel keeps the field and actions above that keyboard without moving on focus. No enrollment was submitted. Portrait rotation was inspected and the original display settings restored. Local screenshots and keyboard-bound evidence are under `artifacts/testing/0.5.32/`.

Physical court-camera capture, OEM screen-lock/background behavior, Android 8/9 save-picker behavior, and export/playback of the two affected originals still require device validation. Emulator checks do not establish production stability on all hardware.
