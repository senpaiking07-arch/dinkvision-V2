package com.casabatik.recorder;

import java.io.File;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;

/** Upload-worker cache for exact bytes. Every attempt still verifies the full SHA-256 seal. */
final class LiveRecordingValidation {
  private static final int MAX_RECEIPTS = 8;
  private final Map<String, Receipt> receipts = new LinkedHashMap<>(MAX_RECEIPTS, 0.75f, true) {
    @Override protected boolean removeEldestEntry(Map.Entry<String, Receipt> eldest) {
      return size() > MAX_RECEIPTS;
    }
  };

  private record Receipt(byte[] digest, long expectedMillis, boolean expectAudio, long durationMillis) {}

  long validate(File file, long expectedMillis, boolean expectAudio) throws RecordingAccuracy.Failure {
    String path = file.getAbsolutePath();
    try {
      byte[] digest = LiveLogoEvidence.requireVerifiedDigest(file);
      Receipt prior = receipts.get(path);
      if (prior != null && prior.expectedMillis() == expectedMillis && prior.expectAudio() == expectAudio
          && MessageDigest.isEqual(prior.digest(), digest)) return prior.durationMillis();
      long durationMillis = RecordedVideo.validate(file, expectedMillis, expectAudio);
      receipts.put(path, new Receipt(digest, expectedMillis, expectAudio, durationMillis));
      return durationMillis;
    } catch (RecordingAccuracy.Failure invalid) {
      receipts.remove(path);
      throw invalid;
    } catch (Exception invalid) {
      receipts.remove(path);
      throw new RecordingAccuracy.Failure("Saved video failed playback validation. Footage was kept on the device.");
    }
  }
}
