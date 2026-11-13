package com.casabatik.recorder;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.camera2.*;
import android.media.MediaRecorder;
import android.os.*;
import android.util.Size;
import java.io.File;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/** Records the Android device's rear camera and microphone into an H.264/AAC MP4. */
final class DeviceCameraRecorder {
  static boolean hasPermissions(Context context) {
    return context.checkSelfPermission(Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED
        && context.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED;
  }

  private static RecordingProfile recordingProfile(CameraCharacteristics details, long max60Pixels, long maxFallbackPixels, String preferred, CameraCapture.Listener listener) throws Exception {
    android.hardware.camera2.params.StreamConfigurationMap map =
        details.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
    Size[] sizes = map == null ? null : map.getOutputSizes(MediaRecorder.class);
    if (sizes == null || sizes.length == 0) throw new Exception("No recordable camera size found.");
    java.util.List<RecordingProfile> candidates = new java.util.ArrayList<>();
    var ranges = details.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
    if (ranges != null) for (Size size : sizes) for (var range : ranges) {
      int fps = range.getUpper();
      long minNs = map.getOutputMinFrameDuration(MediaRecorder.class, size);
      if (fps < 1 || fps > 60 || (minNs > 0 && minNs * (double) fps > 1_010_000_000L)) continue;
      candidates.add(new RecordingProfile(size.getWidth(), size.getHeight(), fps, 0));
    }
    listener.modes(candidates);
    return RecordingProfile.choose(candidates, RecordingProfile::encoderSupports, max60Pixels, maxFallbackPixels, preferred);
  }

  private static String[] selectCamera(CameraManager manager) throws Exception {
    String fallback = null, external = null, back = null;
    for (String id : manager.getCameraIdList()) {
      CameraCharacteristics details = manager.getCameraCharacteristics(id);
      Integer facing = details.get(CameraCharacteristics.LENS_FACING);
      if (fallback == null) fallback = id;
      if (facing == null) continue;
      if (facing == CameraCharacteristics.LENS_FACING_EXTERNAL && external == null) external = id;
      else if (facing == CameraCharacteristics.LENS_FACING_BACK && back == null) back = id;
    }
    if (external != null) return new String[] {external, "USB camera"};
    if (back != null) return new String[] {back, "Built-in camera"};
    if (fallback != null) return new String[] {fallback, "Built-in camera"};
    throw new Exception("This Android device has no camera.");
  }

  static android.util.Range<Integer> recordingRate(android.util.Range<Integer>[] ranges, long minFrameNs) throws Exception {
    return recordingRate(ranges, minFrameNs, 30);
  }
  static android.util.Range<Integer> recordingRate(android.util.Range<Integer>[] ranges, long minFrameNs, int target) throws Exception {
    if (ranges == null || ranges.length == 0)
      throw new RecordingAccuracy.Failure("Camera does not report supported recording frame rates.");
    int ceiling = minFrameNs > 0 ? (int)(1_010_000_000L / minFrameNs) : target;
    android.util.Range<Integer> best = null;
    for (var range : ranges) {
      if (range.getUpper() > Math.min(target, ceiling) || range.getLower() < 1) continue;
      if (best == null || range.getUpper() > best.getUpper()
          || (range.getUpper().equals(best.getUpper()) && range.getLower() > best.getLower())) best = range;
    }
    if (best == null) throw new RecordingAccuracy.Failure("Camera cannot sustain a supported recording mode. Test another camera.");
    return best;
  }

  @SuppressLint("MissingPermission")
  static long capture(
      Context context,
      File file,
      int seconds,
      int countInSeconds,
      BooleanSupplier stop,
      CameraCapture.Listener listener)
      throws Exception {
    return capture(context, file, seconds, countInSeconds, stop, listener, Long.MAX_VALUE, Long.MAX_VALUE, "");
  }
  @SuppressLint("MissingPermission")
  static long capture(Context context, File file, int seconds, int countInSeconds,
      BooleanSupplier stop, CameraCapture.Listener listener, long max60Pixels, long maxFallbackPixels, String preferred) throws Exception {
    if (!hasPermissions(context))
      throw new Exception("Allow camera and microphone permissions in the Android app.");

    CameraManager manager = context.getSystemService(CameraManager.class);
    String[] selection;
    try {
      selection = selectCamera(manager);
    } catch (Exception noPlatformCamera) {
      if (UvcCameraRecorder.hasAttachedCamera(context))
        return UvcCameraRecorder.capture(
            context, file, seconds, countInSeconds, stop, listener, max60Pixels, maxFallbackPixels, preferred);
      throw noPlatformCamera;
    }
    String cameraId = selection[0];
    if (!"USB camera".equals(selection[1]) && UvcCameraRecorder.hasAttachedCamera(context))
      return UvcCameraRecorder.capture(
          context, file, seconds, countInSeconds, stop, listener, max60Pixels, maxFallbackPixels, preferred);
    listener.camera(selection[1]);
    CameraCharacteristics details = manager.getCameraCharacteristics(cameraId);
    RecordingProfile profile = recordingProfile(details, max60Pixels, maxFallbackPixels, preferred, listener);
    Size size = new Size(profile.width, profile.height);
    var map = details.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
    var rate = recordingRate(details.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES),
        map.getOutputMinFrameDuration(MediaRecorder.class, size), profile.fps);
    listener.profile(profile.width, profile.height, profile.fps, profile.bitrate());
    HandlerThread thread = new HandlerThread("wpc-device-camera");
    thread.start();
    Handler handler = new Handler(thread.getLooper());
    MediaRecorder recorder =
        Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(context) : new MediaRecorder();
    LiveLogoProcessor logo = null;
    android.view.Surface encoderSurface = null;
    AtomicReference<CameraDevice> openedCamera = new AtomicReference<>();
    AtomicReference<CameraCaptureSession> openedSession = new AtomicReference<>();
    var closing = new java.util.concurrent.atomic.AtomicBoolean();
    long capturedMillis = 0;
    boolean recording = false;
    boolean captureLive = false;
    boolean finalizing = false;
    try {
      listener.preparation("encoder_prepare");
      recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
      recorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);
      recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
      recorder.setOutputFile(file.getAbsolutePath());
      recorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
      recorder.setVideoEncodingBitRate(profile.bitrate());
      recorder.setVideoFrameRate(rate.getUpper());
      recorder.setVideoSize(size.getWidth(), size.getHeight());
      recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
      recorder.setAudioEncodingBitRate(128_000);
      recorder.setAudioSamplingRate(48_000);
      Integer orientation = details.get(CameraCharacteristics.SENSOR_ORIENTATION);
      if (orientation != null) recorder.setOrientationHint(orientation);
      recorder.prepare();
      android.hardware.usb.UsbDevice usbCamera = null;
      if ("USB camera".equals(selection[1])) {
        var usbManager = context.getSystemService(android.hardware.usb.UsbManager.class);
        if (usbManager != null) for (var device : usbManager.getDeviceList().values())
          if (UvcCameraRecorder.isUvcDevice(device)) { usbCamera = device; break; }
      }
      listener.preparation("microphone_prepare");
      RecordingAudioInput audio = new RecordingAudioInput(context, usbCamera);
      audio.prefer(recorder);

      CountDownLatch opened = new CountDownLatch(1);
      AtomicReference<Exception> failure = new AtomicReference<>();
      java.util.concurrent.atomic.AtomicLong lastFrame = new java.util.concurrent.atomic.AtomicLong(System.nanoTime());
      recorder.setOnErrorListener((r, what, extra) -> failure.compareAndSet(null,
          new CameraCapture.Interruption(CameraCapture.InterruptionCode.CAMERA_FAILURE, "Android camera encoder failed.")));
      listener.preparation("camera_connect");
      manager.openCamera(
          cameraId,
          new CameraDevice.StateCallback() {
            public void onOpened(CameraDevice value) {
              openedCamera.set(value);
              if (closing.get() && openedCamera.compareAndSet(value, null)) value.close();
              opened.countDown();
            }

            public void onDisconnected(CameraDevice value) {
              value.close();
              failure.compareAndSet(null, new CameraCapture.Interruption(
                  CameraCapture.InterruptionCode.CAMERA_DISCONNECTED, "Android camera disconnected."));
              opened.countDown();
            }

            public void onError(CameraDevice value, int error) {
              value.close();
              failure.compareAndSet(null, new CameraCapture.Interruption(
                  CameraCapture.InterruptionCode.CAMERA_FAILURE, "Android camera failed."));
              opened.countDown();
            }
          },
          new Handler(context.getMainLooper()));
      CameraCapture.await(opened, 10, stop, failure, "Timed out while opening the Android camera.");
      CameraDevice camera = openedCamera.get();
      if (camera == null) throw new Exception("Android camera could not be opened.");

      listener.preparation("encoder_prepare");
      encoderSurface = recorder.getSurface();
      logo = new LiveLogoProcessor(context, encoderSurface, profile.width, profile.height,
          orientation == null ? 0 : orientation, false, listener.validateSavedMediaInBackground(),
          error -> failure.compareAndSet(null, error));
      android.view.Surface surface = logo.input();
      CaptureRequest.Builder request = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
      request.addTarget(surface);
      request.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
      request.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, rate);
      int[] focusModes = details.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
      if (focusModes != null)
        for (int mode : focusModes)
          if (mode == CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO) {
            request.set(CaptureRequest.CONTROL_AF_MODE, mode);
            break;
          }
      CountDownLatch configured = new CountDownLatch(1);
      camera.createCaptureSession(
          Collections.singletonList(surface),
          new CameraCaptureSession.StateCallback() {
            public void onConfigured(CameraCaptureSession value) {
              openedSession.set(value);
              if (closing.get() && openedSession.compareAndSet(value, null)) value.close();
              configured.countDown();
            }

            public void onConfigureFailed(CameraCaptureSession value) {
              value.close();
              failure.compareAndSet(null, new CameraCapture.StartFailure("Android camera recording could not be configured."));
              configured.countDown();
            }
          },
          handler);
      CameraCapture.await(configured, 10, stop, failure, "Timed out while preparing the Android camera.");
      CameraCaptureSession session = openedSession.get();
      if (session == null) throw new Exception("Android camera recording could not be configured.");
      session.setRepeatingRequest(request.build(), new CameraCaptureSession.CaptureCallback() {
        private final RecordingAccuracy.Timeline clock = new RecordingAccuracy.Timeline();
        @Override public void onCaptureCompleted(CameraCaptureSession s, CaptureRequest request, TotalCaptureResult result) {
          long now = System.nanoTime();
          Long timestamp = result.get(CaptureResult.SENSOR_TIMESTAMP);
          lastFrame.set(now);
          if (timestamp != null) try { clock.observe(timestamp / 1000, now); }
          catch (RecordingAccuracy.Failure e) { failure.set(e); }
        }
      }, handler);

      CameraCapture.await(logo.firstInputFrame, 6, stop, failure,
          "The Android camera opened but did not deliver video.");
      CameraCapture.countIn(countInSeconds, stop, failure, listener);

      recorder.start();
      recording = true;
      logo.startEncoding();
      CameraCapture.await(logo.firstEncodedFrame, 6, stop, failure,
          "The Android camera encoder did not receive a video frame.");
      long start = System.nanoTime();
      lastFrame.set(start);
      // Keep "1" visible while MediaRecorder performs its native startup.
      // Clear the countdown only once capture has actually begun.
      listener.countdown(0);
      listener.started();
      captureLive = true;
      long targetNanos = TimeUnit.SECONDS.toNanos(seconds);
      if (countInSeconds == 0 && seconds == 3) targetNanos += TimeUnit.MILLISECONDS.toNanos(350);
      while (!stop.getAsBoolean()
          && System.nanoTime() - start < targetNanos) {
        if (failure.get() != null) throw failure.get();
        audio.observe(recorder, start);
        if (audio.isVerified()) listener.audio(audio.label());
        if (System.nanoTime() - lastFrame.get() > 3_000_000_000L)
          throw new CameraCapture.Interruption(CameraCapture.InterruptionCode.CAMERA_FAILURE,
              "The Android camera stopped delivering video.");
        listener.frame((int) ((System.nanoTime() - start) / 1_000_000_000L));
        if (file.getParentFile().getUsableSpace() < 50_000_000)
          throw new CameraCapture.Interruption(CameraCapture.InterruptionCode.STORAGE_FULL, "Tablet storage is nearly full.");
        Thread.sleep(100);
      }
      capturedMillis = Math.max(1, (System.nanoTime() - start) / 1_000_000L);
      audio.requireVerified();
      listener.audio(audio.label());
      finalizing = true;
      listener.finalizing();
      try { session.stopRepeating(); } catch (CameraAccessException | IllegalStateException ignored) { }
      logo.stop();
      recording = false;
      recorder.stop();
      logo.completed(file);
    } catch (Exception failure) {
      if (captureLive && !finalizing) {
        CameraCapture.Interruption interruption = CameraCapture.Interruption.observed(failure);
        listener.interrupted(interruption);
        CameraCaptureSession session = openedSession.get();
        if (session != null) try { session.stopRepeating(); } catch (Exception ignored) { }
        logo.stop();
        recording = false;
        try {
          recorder.stop();
          logo.completed(file);
        } catch (Exception incomplete) { interruption.addSuppressed(incomplete); }
        throw interruption;
      }
      if (failure instanceof RuntimeException)
        throw new Exception("Android camera could not save a complete recording.", failure);
      throw failure;
    } finally {
      closing.set(true);
      if (recording) try { recorder.stop(); } catch (Exception ignored) {}
      CameraCaptureSession session = openedSession.getAndSet(null);
      CameraDevice camera = openedCamera.getAndSet(null);
      if (session != null) try { session.close(); } catch (RuntimeException ignored) { }
      if (camera != null) try { camera.close(); } catch (RuntimeException ignored) { }
      if (logo != null) logo.close();
      if (encoderSurface != null) encoderSurface.release();
      try {
        recorder.reset();
      } catch (Exception ignored) {
      }
      recorder.release();
      thread.quitSafely();
    }
    return capturedMillis;
  }
}
