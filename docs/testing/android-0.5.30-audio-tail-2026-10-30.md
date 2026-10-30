# Android 0.5.30 audio-tail investigation — October 30, 2026

The operator reported that the five-minute replay played through but lost sound near the end while the picture continued. The delivered file was inspected without changing the hosted copy. Recipient details and file identifiers are omitted.

| Evidence | Video end | Audio end | Difference |
| --- | ---: | ---: | ---: |
| Delivered 0.5.29 five-minute replay | about 300.06 s | about 298.96 s | about 1.10 s |
| New raw 12-second EMEET USB capture | 11.993 s | 11.863 s | 0.130 s |
| Same capture after 0.5.30 branding | 12.014 s | 11.883 s | 0.131 s |
| Second raw 12-second EMEET capture | 11.998 s | 11.841 s | 0.157 s |
| Second capture after 0.5.30 branding | 12.019 s | 11.861 s | 0.158 s |
| New raw five-minute EMEET capture | 300.043 s | 299.976 s | 0.067 s |
| New capture after 0.5.30 branding | 300.089 s | 299.989 s | 0.100 s |

The watermark step previously ignored audio frames decoded before the first video frame. The EMEET MP4 can yield audio first even though its audio and video timestamps start together. Preserving those frames kept the audio and picture aligned in both new camera captures. Saved-video validation now rejects tracks whose end timestamps differ by more than 0.5 seconds, leaving a defective recording local instead of emailing it. The already delivered 0.5.29 replay is unchanged.

On the Samsung SM-A226B with EMEET SmartCam C60E 4K, `assembleDebug`, `assembleDebugAndroidTest`, and `lintDebug` passed. A temporary hardware diagnostic captured and branded the two 12-second EMEET samples, then was removed. Nine persistent connected tests passed with the final source tree, including the existing three-second camera preview, a full-clip branding regression, and a synthetic MP4 with audio that stops one second early. The synthetic fixture contains generated test pattern video and a sine wave, not a player recording.

The in-place 0.5.30 test install preserved enrollment and the previously recovered local clip. A new five-minute recording finished, was branded, uploaded, and generated a replay email. The delivered Drive file matched the branded phone file byte for byte by SHA-256 and decoded from start to end without errors. No silent interval of at least 0.2 seconds (below -45 dB) was detected in its last six seconds. The operator confirmed that sound continues through the end of the new replay. The upload-confirmed full-length local file was removed; the older short local clip was retained. This is a debug-signed test APK, not a production-signed release.
