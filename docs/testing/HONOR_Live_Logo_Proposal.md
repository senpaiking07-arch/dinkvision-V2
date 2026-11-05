# Proposed live logo pipeline — approval required

Measured on 2026-11-04 (Asia/Taipei), on the existing HONOR YAG-W09 and EMEET S600. The user approved this proposal before implementation. Prototype results and remaining acceptance checks are recorded in `Android_Recorder_Workflow_0.5.41.md`; live-logo mode remains off in the installed enrolled app.

## Current findings

- Installed/source baseline: 0.5.40 (46), local package `com.casabatik.recorder.dev`.
- The current 25-minute source is 2,941,833,610 bytes, 1920×1080, 52.1458 measured FPS, approximately 15.69 Mbps including audio/container. The selected target remains 60 FPS. The latest camera-test result is 41.5 FPS, which is not a verified 60 FPS capture rate.
- At the first observation, post-processing was at 38% after 2,991.8 seconds, averaging 9.04 encoded FPS; recent ten-second intervals delivered about 10.9 FPS. This is roughly 0.2× real time. A full 25-minute source would take roughly two hours at that sustained rate, excluding suspensions, retries and upload. This is an estimate, not a completed-run measurement.
- Waiting sources are 349.562 seconds / 685,619,716 bytes and 280.429 seconds / 550,076,773 bytes. The three sources total 4.18 GB before temporary branded output and Gallery copies. At the observed source bitrate, continuous capture adds approximately 7.06 GB per hour. Current free storage is about 76 GiB.
- Process CPU was 175% (about 1.75 cores), resident memory 357 MiB, reported thermal status 0. Software libopenh264 remains the branding encoder. Uploads cannot drain this backlog until branding finishes.
- The previous total deadline is already removed. The current run passed 45 minutes and continues progressing. Two waiting jobs retain retry count zero and fresh queue-presence timestamps in hosted Supabase project `zjfeavhxqunlqdriroxg`.
- An earlier attempt on the same source reached 16%, then had a roughly two-hour diagnostic gap before the three-minute no-progress exception was reported. The log does not prove whether suspension or a blocked native operation caused the gap. The source survived and is now retrying. Do not dismiss this as ordinary waiting.
- Current queued files have zero uploaded bytes and no Drive objects yet. Prior verified 0.5.40 acceptance uploads took approximately 75–143 seconds for 114–127 MB (roughly 0.9–1.5 MB/s end-to-end, including API/finalization overhead). This is historical throughput, not a new isolated bandwidth benchmark.

## Proposed implementation

Start with an opt-in USB-camera prototype, leaving the existing recording path as the default until accepted. Insert an offscreen OpenGL ES compositor between the existing UVC renderer and the hardware encoder's input Surface. Draw the camera texture and logo into the encoded output, preserving the incoming texture transform, aspect ratio, orientation and presentation timestamps. Keep the current encoder settings, audio routing, audio timestamps and muxer. Do not tie the compositor's lifetime to a visible preview or Activity.

The vendored `VideoCapture` currently creates a MediaCodec input Surface and registers it with `ICameraRendererHolder.addSlaveSurface`. That is the integration point to investigate, not a WebView/preview overlay. Android documents hardware rendering into encoder Surfaces: https://developer.android.com/reference/android/media/MediaCodec#createInputSurface() and texture transforms/timestamps: https://source.android.com/docs/core/graphics/arch-st.

Persist a verified live-branding marker only after finalization and media validation. The uploader may skip post-processing only for a validated marked file. Preserve existing worker limits, FIFO handling, branded retry reuse, original protection and legacy post-processing for older saved files.

## Compatibility and fallback

- Requires a working hardware encoder Surface and EGL path at the exact selected mode; do not silently reduce dimensions, bitrate or target FPS.
- Before recording, failed live-path validation falls back explicitly to the current capture plus post-processing path and tells the operator. A mid-recording compositor/encoder failure preserves recoverable footage and reports the actual stage; it must never mark an unbranded or incomplete video complete.
- Keep camera-microphone priority and device-microphone fallback unchanged.
- Built-in Camera2/device recording retains its existing path initially. USB implementation must be verified before extending support.
- HONOR suspension behavior remains a separate acceptance risk. Foreground-service operation and screen-locked capture/processing require sustained tests; GPU compositing alone does not prove background reliability.
- The client REDMI Pad 2 9.7 4G is unavailable in this session. No performance or compatibility claim applies to it or Samsung based on this HONOR result.

## Acceptance before enabling

Disposable recordings at each selected mode; verify saved-file logo placement/orientation, first/last frames, actual FPS, duration and audio sync. Then consecutive 61–90-second recordings followed by 15/20/25-minute recordings; minimized and screen-locked operation; network interruption, restart recovery and upload retry without recompositing. Compare processing backlog, CPU, storage growth and upload throughput against the measurements above. Real footage remains untouched.

Approval requested: implement and test this opt-in USB live-watermark prototype locally, with the fallback above. No deployment or shared-database migration is included.
