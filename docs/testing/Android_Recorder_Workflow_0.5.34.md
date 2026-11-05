# DinkVision 0.5.34 — device, Admin and database verification

Historical results for 0.5.34 are retained below. The current candidate and additional checks are documented in [0.5.35](Android_Recorder_Workflow_0.5.35.md).

Updated 2026-11-02, Asia/Manila. Android version **0.5.34**, build **40**. This is a local test candidate. No GitHub push or web deployment was performed. The Samsung runs `com.casabatik.recorder.dev` against the local VS Code backend; the ordinary APK retains the configured hosted HTTPS origin.

## Corrections

- **Enrollment:** a temporary API failure retains the app's saved registration. The ten-minute code is used to obtain that registration; it is not the lifetime of the device registration. Native enrollment rejects an accidental second submission unless replacement was chosen. Admin requires explicit confirmation before creating a replacement code for an already registered entry. Concurrent redemption is atomic: one code can succeed once. Same-entry re-enrollment preserves the kiosk/recording owner. Uninstalling still erases Android private data; use the same Admin entry to enroll again.
- **Local file reconciliation:** the authenticated device manifest is checked against the local journal/files. An inactive server record that claims a private file erased by reinstall is reported unavailable. The app does not infer that an active recording is missing, or attach an unknown file to another device's record. A disconnected tablet's last report cannot prove its current file availability.
- **Gallery/Files exports:** a successful copy creates a durable receipt with byte count. The app retries reporting it after an outage. The database records server confirmation time and byte count on that recording; Admin shows “Copy exported to Gallery / Files.” No private Android URI is sent to the server. Concurrent upload/branding journal updates preserve the receipt. An export receipt confirms a completed copy at that time; it cannot prove that someone has not subsequently deleted it from Gallery.
- **Contact status:** authenticated actions and upload chunks update device contact, not just idle heartbeats. Admin uses server time and distinguishes delayed/unconfirmed contact from a deliberately disabled device. A fresh Admin retry request does not prove the tablet is online or adding a logo. Old logo work becomes “Waiting for device · file check pending.” A private upload copy released after verified cloud upload is distinguished from a missing unuploaded file.
- **Admin stop:** the APK polls commands while recording, matches the exact active session, and treats repeated stop requests safely. An unrelated session cannot stop the camera.
- **Background capture:** an explicit camera-work service request keeps camera/microphone foreground classification while server state loads. Android-muted or unexpected microphone routes still fail validation rather than approving silent footage.
- **Activity recreation:** camera approval belongs to the app process. Recreating the screen no longer clears it during background work; cold process launch, USB reconnect and configuration changes still require the camera check. This reset was reproduced in a lifecycle regression test before correction.
- **Logo progress:** percentages use processed video timestamps. Rendering stops at 98%, validation/safe replacement uses the final step, and 100% is emitted only after the saved output validates. Saved videos, the Android notification and Admin can show measured progress. Older/unreported data uses a static waiting state, never an animated bar implying live work. A stale device displays its last reported value. A restarted processing attempt starts from its real beginning rather than inventing progress.
- **Per-video Admin queue:** the shared bottom meter is removed. Each uploading video has its own bar, uploaded MB / total MB and separator. Active work is numbered: current processing/upload first, then FIFO waiting clips, then scheduled retries. Failed and local-only history follows the active queue. A retry becomes eligible according to the device's backoff; it is not a guarantee of a fixed completion time. Positive source sizes are reported while adding the logo; final branded sizes replace them when ready. MB follows the Android display, using 1,048,576 bytes.
- **Recording-log diagnostics:** reason, stage, device report and recovery action have separate labels. `device_removed` means the Admin device registration was removed. Missing historical data explicitly says “Not reported”; no cause is invented. Local-only clips are identified as a policy outcome, and raw codes remain available for tracing.
- **Storage preflight:** the free-space budget now covers both the original and the temporary branded output at the supported maximum bitrate, plus reserve. A 15-minute match requires about 1.93 billion free bytes before capture. This prevents admitting a match using an estimate too small for its safe processing copy.

The date/player names, saved-video preview/seek fix, processing indicator, export and retry controls, camera check after launch/reconnect, USB-microphone priority with built-in fallback, count-up timer and navy/teal theme from 0.5.33 are retained. See [0.5.33 workflow](Android_Recorder_Workflow_0.5.33.md) for their detailed behavior.

## Start-to-finish workflow

1. Create/select the intended device entry in Admin. Redeem its code once on the physical phone/tablet. Update with install-over-existing-data to preserve enrollment and private footage. Replacing a registration is an intentional staff action.
2. On app launch or USB reconnect, record the three-second check, review picture/sound, and confirm. Gmail entry remains blocked until this check passes. Camera microphone is preferred when Android exposes it; otherwise the device microphone is used and identified.
3. Enter up to four addresses manually, review them, and start. The prepared camera counts 3–2–1, then the timer counts from 00:00 up to the configured maximum. Stop locally or through Admin.
4. The original is persisted before logo processing/upload. It is shown as processing and cannot be previewed mid-processing. Failed originals remain available for inspection/export. Under-one-minute clips stay local and are not emailed.
5. A completed capture frees the camera for the next group. Existing uploads retain their original session and recipients. Automatic retry is bounded at eight failed attempts with backoff; a staff/manual retry restarts work for that same saved recording. A timing-validation failure needs inspection and does not burn eight identical attempts.
6. In Saved videos, preview/seek the completed file, save a separate Gallery/Files copy, or retry a failed upload/processing job. The export receipt synchronizes to Admin when contact returns.
7. Verified Drive completion releases the private upload copy; Gallery copies remain. Email delivery is a separate status. The recording ID is available in Details/logs while the visible label shows date and players.

## Test scope and evidence

Physical hardware: Samsung **SM-A226B**, Android **13/API 33**, **EMEET SmartCam C60E 4K** through OTG, wireless ADB. Camera USB microphone reported and verified by Android. The user confirmed clear picture and sound after the final rebuild. No emulator was used for this run.

| Scenario | Result / scope |
| --- | --- |
| Fresh uninstall/install, initial enrollment, invalid/expired code, permissions denied and restored | Passed on Samsung. The previous private clip was backed up before the authorized uninstall. |
| One code redeemed by five concurrent clients, followed by five replay attempts | Passed: exactly one initial success, zero replay successes, one existing Admin identity. Isolated “Emulator Test” entry only; no court registration changed. |
| Network outage and reconnect | Passed: stored registration/kiosk unchanged; contact became delayed during the outage and recovered without re-enrollment. |
| Same-entry enrollment and old private-file availability | Passed: identity retained; erased private footage was corrected to unavailable in the database. |
| Gmail validation, four recipients, duplicate/fifth-address rejection, removal/edit/confirmation | Passed on physical WebView. Only the user-authorized test recipient was used for actual captures. |
| Repeated Admin stop on a live capture | Passed: two requests accepted; phone completed after approximately 2.2 seconds. Saved clip remained associated with the test group. |
| Private playback and seek | Passed on the newly saved clip. Date/recipient label shown. |
| Gallery export while its reporting endpoint was unavailable | Passed: readable copy created, receipt remained pending, then database confirmation arrived with **8,532,756 bytes** on the correct session. |
| Background/screen-lock capture and audio/video timing validation | Six-second instrumentation capture passed after foreground classification correction. Longer end-to-end result is recorded below. |
| Upload/branding receipt race | Regression reproduced before correction, then passed; stale worker snapshots cannot erase the receipt or reset its acknowledgement. |
| Layouts, processing preview, recovery actions | Physical WebView checks passed at 320×480 through 2560×1600 logical viewports, including four-address forms and 44px controls. These are logical layouts on one phone, not separate hardware models. |
| Build and API/database tests | 157/157 application tests passed; Next.js production build/type checking passed; Android ordinary/local debug builds and lint passed, **0 errors / 43 warnings**. |
| Android instrumentation | 55 distinct tests passed across the final **53-test unlocked suite** and two physical recording-accuracy checks. Targeted reruns cover the progress panel at all logical sizes and lifecycle approval. Earlier failures exposed an uninitialized test-image buffer and a progress-panel overflow; both were corrected and their tests passed. The screen-lock check is kept separate to avoid a locked 0×0 WebView during UI tests. |

The first long-run attempt stopped at 188 seconds when the USB camera physically disappeared/reconnected. The user confirmed moving/reconnecting the hardware. Its partial footage was subsequently recovered and uploaded with email sent. It is not counted as a successful 15-minute run or evidence that ordinary screen lock detached the camera.

### Full-length repeat

The repeat reached the configured **15-minute limit** with the screen off. The native capture reported **900,008 ms** and persisted a **686,520,980-byte** original. Source validation passed and logo processing continued while locked. The validated branded file was **900,208 ms** and **686,931,853 bytes (655.1 MB)**. A controlled upload-endpoint outage retained the original and scheduled retry. Restoring the endpoint resumed the same session; Drive verification reached ready/uploaded and Gmail accepted its replay email. The private upload copy was released only after verified completion.

There were **zero stale-contact samples** across capture, logo work, retry and upload. Another group entered its address and recorded a separate short clip using the same test recipient while the long upload continued. Session IDs and recipients stayed separate.

Observed post-processing on this Samsung took approximately **12 minutes to add the logo** and **8 minutes to transfer/verify** the 15-minute clip, including the controlled retry. A busy court running back-to-back 15-minute sessions can therefore accumulate a queue on this hardware/network. Qualify sustained throughput and free storage on the actual deployment tablet; this test does not certify peak-court capacity. The full-length run preceded the later progress/lifecycle UI changes; those changes have separate regression and physical progress checks.

### Final physical progress check on Device Test

The final APK recorded a **45-second local-only clip**. While another app/Home was foregrounded, the database percentage advanced **0 → 7 → 26**. While the screen was locked, it advanced **26 → 46 → 65**, then reached **100** after output validation. The final database size was **35,111,246 bytes** and policy state `local_only`; no replay email was sent for this under-one-minute clip. The camera approval remained valid in the same app process. The installed APK's SHA-256 exactly matched the exported local-test candidate.

Final consistency checks found **one enabled Device Test registration with an active kiosk**. All **four private saved videos** matched the database's local-availability IDs and exact byte counts. APK inventory/version and device contact agreed. The fault proxy was stopped and the normal `3000 → 3000` ADB reverse connection restored. Remaining live tests were restricted to Device Test after the user requested that scope.

Earlier short-window progress sampling began before the encoder had warmed up, so that eight-second minimized observation saw only the first 0% report; a longer observation window established advancement in both modes. Native percentages are finer-grained than the periodic server reports. The display does not imply a per-second upload/encoding update.

Local evidence (ignored by Git): `.local/fresh-run-20261102/` contains scenario assertions, native instrumentation logs, build/test logs, contact/transfer samples and exact test-session IDs. APK SHA-256 sidecars accompany the artifacts. Secrets and account files are excluded from this report.

## Release checks that still need real conditions

- Run 20- and 25-minute recordings on the intended court tablet, camera, powered OTG/hub and final release signing setup. Repeat the configured 15-minute run on each additional deployment hardware combination.
- Test a camera without a microphone to verify the reported built-in fallback, additional USB camera models, different OTG/hubs and Android/OEM versions. The EMEET/Samsung result does not certify other hardware.
- Test incoming phone calls, other camera/voice apps, microphone privacy switch, notification/system interruptions, battery saver/low battery, thermal load and real storage exhaustion. Android or cable/power loss cannot be made equivalent to uninterrupted capture; footage recovery must remain explicit.
- Test a real device power loss/reboot during capture, logo processing, Gallery export and upload using expendable footage. Process-interruption/safe-swap tests are not a physical power-loss test. Uninstall/data clearing can permanently erase unexported private footage.
- Run sustained poor-bandwidth/server-unavailable/large-file tests and long real backoff exhaustion. Automated tests cover queue sizes two through five, retry bounds, ownership, corruption and interrupted transfers; they do not certify the venue's network capacity.
- Inspect the older court originals that failed audio/video end validation on their original tablet. No validation was relaxed, and those files/registrations were not deleted, cancelled or replaced.
- Review Admin visually in the actual desktop browser. Computer Use stopped because it could not confidently determine the browser URL; it was not bypassed. API contracts, database results, rendering helpers and production build were checked separately.
- Configure/verify production signing and the production retry/email/retention scheduler. The backend changes must be deliberately published before a hosted APK can use them. No GitHub push/deployment was performed.
