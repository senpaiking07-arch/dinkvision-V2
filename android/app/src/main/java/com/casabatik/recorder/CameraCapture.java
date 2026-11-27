package com.casabatik.recorder;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/** Events shared by the built-in Camera2 and direct USB/UVC capture paths. */
final class CameraCapture {
  private CameraCapture() {}

  static final class StartFailure extends Exception {
    StartFailure(String message) { super(message); }
  }

  static final class StartCancelled extends Exception {
    StartCancelled() { super("Recording start was cancelled. You can try again."); }
  }

  enum InterruptionCode {
    CAMERA_DISCONNECTED("camera_disconnected"),
    CAMERA_FAILURE("camera_failure"),
    STORAGE_FULL("storage_full"),
    APP_INTERRUPTED("app_interrupted"),
    UNKNOWN("unknown");

    final String value;
    InterruptionCode(String value) { this.value = value; }
  }

  static final class Interruption extends Exception {
    final InterruptionCode code;
    final long occurredAt = System.currentTimeMillis();
    Interruption(InterruptionCode code, String message) {
      super(message);
      this.code = code;
    }

    static Interruption observed(Exception failure) {
      if (failure instanceof Interruption) return (Interruption) failure;
      return new Interruption(InterruptionCode.UNKNOWN, "Recording ended unexpectedly.");
    }
  }

  static void checkStarting(BooleanSupplier stop, AtomicReference<Exception> failure) throws Exception {
    Exception error = failure.get();
    if (error != null) throw error;
    if (stop.getAsBoolean()) throw new StartCancelled();
  }

  static void await(CountDownLatch signal, int seconds, BooleanSupplier stop,
      AtomicReference<Exception> failure, String timeout) throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
    while (signal.getCount() > 0 && System.nanoTime() < deadline) {
      checkStarting(stop, failure);
      signal.await(50, TimeUnit.MILLISECONDS);
    }
    checkStarting(stop, failure);
    if (signal.getCount() > 0) throw new StartFailure(timeout);
  }

  static void countIn(int seconds, BooleanSupplier stop, AtomicReference<Exception> failure,
      Listener listener) throws Exception {
    checkStarting(stop, failure);
    listener.ready();
    for (int value = seconds; value > 0; value--) {
      checkStarting(stop, failure);
      listener.countdown(value);
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
      while (System.nanoTime() < deadline) {
        checkStarting(stop, failure);
        Thread.sleep(25);
      }
    }
    checkStarting(stop, failure);
  }

  interface Listener {
    void ready() throws Exception;

    void countdown(int value);

    void started() throws Exception;

    void frame(int seconds);

    default void preparation(String stage) {}
    default byte[] courtLogo() { return null; }
    default void camera(String label) {}

    default void audio(String label) {}
    default void profile(int width, int height, int fps, int bitrate) throws Exception {}
    default void modes(java.util.List<RecordingProfile> modes) throws Exception {}

    default void finalizing() {}
    default void interrupted(Interruption interruption) {}
    default boolean validateSavedMediaInBackground() { return false; }
  }
}
