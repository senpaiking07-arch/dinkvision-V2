# UVCAndroid 1.0.13 audio input hook

Source: https://github.com/shiyinghan/UVCAndroid/blob/1.0.13/libuvccamera/src/main/java/com/herohan/uvcapp/VideoCapture.java
License: Apache-2.0 (included).

The audio change adds `AudioInputCallback` at AudioRecord creation. DinkVision uses public Android `AudioRecord.setPreferredDevice` and `getRoutedDevice` APIs to select the camera microphone and verify its actual route. A scoped lint annotation documents the caller's runtime permission checks. Encoder creation also uses `MediaCodecList.findEncoderForFormat` for the selected resolution, bitrate and frame rate. During the library's initial camera open, before supported modes can be enumerated, it retains the upstream type-based initialization fallback; the selected supported format is configured before recording. Upstream timing and muxer code is retained. License and modification notices are packaged in the APK assets.

The build downloads the pinned upstream AAR, checks its SHA-256, and replaces only VideoCapture and its nested classes with this source. Native drivers, resources and the original transitive dependency versions are retained. No reflection, hidden Android API, root permission, or global audio policy change is used.

Codec cleanup covers failed configuration before an input surface exists. It also releases resources when `release()` arrives after the recording-reset FutureTask has completed, or races with its completion. Cleanup is idempotent. This prevents successive captures and quality checks from exhausting the device's hardware encoder pool; a physical ten-capture regression check covers that lifecycle.

When updating UVCAndroid, refresh the pinned source/checksum and review this hook against the new upstream recorder lifecycle. Test video, microphone selection, sound through the end, reconnect and screen-off capture on physical hardware.
