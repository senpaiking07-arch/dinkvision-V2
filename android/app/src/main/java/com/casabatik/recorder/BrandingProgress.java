package com.casabatik.recorder;

/** A slow encoder is healthy while successfully written media time advances. */
final class BrandingProgress {
  static final long STALL_NANOS = 180_000_000_000L;
  private long lastAdvanceNanos;
  private long mediaMicros = -1;
  private long audioMicros = -1;

  BrandingProgress(long nowNanos) { lastAdvanceNanos = nowNanos; }

  void check(long nowNanos) throws Exception {
    if (nowNanos - lastAdvanceNanos > STALL_NANOS)
      throw new Exception("Logo processing stalled: no encoded media progress for 3 minutes. The original video was preserved.");
  }

  void advanced(long timestampMicros, long nowNanos) throws Exception {
    if (timestampMicros > mediaMicros) {
      mediaMicros = timestampMicros;
      lastAdvanceNanos = nowNanos;
    } else check(nowNanos);
  }

  void advancedAudio(long timestampMicros, long nowNanos) throws Exception {
    if (timestampMicros > audioMicros) {
      audioMicros = timestampMicros;
      lastAdvanceNanos = nowNanos;
    } else check(nowNanos);
  }
}
