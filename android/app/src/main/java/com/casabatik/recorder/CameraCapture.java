package com.casabatik.recorder;

/** Events shared by the built-in Camera2 and direct USB/UVC capture paths. */
final class CameraCapture {
  private CameraCapture() {}

  interface Listener {
    void ready() throws Exception;

    void countdown(int value);

    void started() throws Exception;

    void frame(int seconds);

    default void camera(String label) {}

    default void finalizing() {}
  }
}
