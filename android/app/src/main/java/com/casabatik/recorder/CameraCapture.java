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

    default void audio(String label) {}
    default void profile(int width, int height, int fps, int bitrate) throws Exception {}
    default void modes(java.util.List<RecordingProfile> modes) throws Exception {}

    default void finalizing() {}
  }
}
