package com.casabatik.recorder;

import android.content.Context;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.util.Log;
import com.herohan.uvcapp.CameraException;
import com.herohan.uvcapp.CameraHelper;
import com.herohan.uvcapp.ICameraHelper;
import com.herohan.uvcapp.VideoCapture;
import com.serenegiant.usb.Size;
import com.serenegiant.usb.UVCCamera;
import com.serenegiant.usb.UVCParam;
import com.serenegiant.utils.UVCUtils;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/** Direct USB-host/UVC capture for Android devices that do not expose webcams through Camera2. */
final class UvcCameraRecorder {
  private static final String TAG = "DinkVision-UVC";

  private UvcCameraRecorder() {}

  static boolean isUvcDevice(UsbDevice device) {
    if (device == null) return false;
    if (device.getDeviceClass() == UsbConstants.USB_CLASS_VIDEO) return true;
    for (int index = 0; index < device.getInterfaceCount(); index++) {
      UsbInterface face = device.getInterface(index);
      if (face.getInterfaceClass() == UsbConstants.USB_CLASS_VIDEO
          && (face.getInterfaceSubclass() == 1 || face.getInterfaceSubclass() == 2)) return true;
    }
    return false;
  }

  static boolean hasAttachedCamera(Context context) {
    UsbManager manager = context.getSystemService(UsbManager.class);
    if (manager == null) return false;
    for (UsbDevice device : manager.getDeviceList().values())
      if (isUvcDevice(device)) return true;
    return false;
  }

  static String connectionKey(Context context) {
    UsbManager manager = context.getSystemService(UsbManager.class);
    List<String> keys = new ArrayList<>();
    if (manager != null) for (UsbDevice device : manager.getDeviceList().values())
      if (isUvcDevice(device)) keys.add(device.getVendorId() + ":" + device.getProductId() + ":" + device.getDeviceId());
    java.util.Collections.sort(keys);
    return keys.isEmpty() ? "built-in" : String.join(",", keys);
  }

  static Size chooseRecordingSize(List<Size> sizes) throws Exception {
    return chooseRecordingSize(sizes, RecordingProfile::encoderSupports);
  }

  static Size chooseRecordingSize(List<Size> sizes, RecordingProfile.EncoderSupport encoder) throws Exception {
    return chooseRecordingSize(sizes, encoder, Long.MAX_VALUE);
  }
  static Size chooseRecordingSize(List<Size> sizes, RecordingProfile.EncoderSupport encoder, long max60Pixels) throws Exception {
    return chooseRecordingSize(sizes, encoder, max60Pixels, Long.MAX_VALUE);
  }
  static Size chooseRecordingSize(List<Size> sizes, RecordingProfile.EncoderSupport encoder, long max60Pixels, long maxFallbackPixels) throws Exception {
    return chooseRecordingSize(sizes, encoder, max60Pixels, maxFallbackPixels, "");
  }
  static Size chooseRecordingSize(List<Size> sizes, RecordingProfile.EncoderSupport encoder, long max60Pixels, long maxFallbackPixels, String preferred) throws Exception {
    if (sizes == null || sizes.isEmpty())
      throw new Exception("The USB camera did not report a usable video format.");
    List<RecordingProfile> candidates = recordingModes(sizes);
    RecordingProfile chosen = RecordingProfile.choose(candidates, encoder, max60Pixels, maxFallbackPixels, preferred);
    return new Size(chosen.format, chosen.width, chosen.height, chosen.fps,
        java.util.Collections.singletonList(chosen.fps));
  }
  private static List<RecordingProfile> recordingModes(List<Size> sizes) {
    List<RecordingProfile> candidates = new ArrayList<>();
    for (Size size : sizes) {
      if (size == null) continue;
      List<Integer> rates = size.fpsList == null || size.fpsList.isEmpty()
          ? java.util.Collections.singletonList(size.fps) : size.fpsList;
      for (Integer fps : rates) if (fps != null && fps > 0)
        candidates.add(new RecordingProfile(size.width, size.height, fps, size.type));
    }
    return candidates;
  }

  private static void throwFailure(AtomicReference<Exception> failure) throws Exception {
    Exception value = failure.get();
    if (value != null) throw value;
  }

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
  static long capture(Context context, File file, int seconds, int countInSeconds,
      BooleanSupplier stop, CameraCapture.Listener listener, long max60Pixels, long maxFallbackPixels, String preferred) throws Exception {
    if (!DeviceCameraRecorder.hasPermissions(context))
      throw new Exception("Allow camera and microphone permissions in the Android app.");
    if (!hasAttachedCamera(context))
      throw new Exception("Connect a UVC-compatible USB camera through an OTG adapter, then retry.");

    UVCUtils.init(context);
    AtomicReference<CameraHelper> helperRef = new AtomicReference<>();
    AtomicReference<UsbDevice> selected = new AtomicReference<>();
    AtomicReference<Exception> failure = new AtomicReference<>();
    AtomicReference<LiveLogoProcessor> watermark = new AtomicReference<>();
    CountDownLatch encoderPrepared = new CountDownLatch(1);
    VideoCapture.setSurfaceProcessorFactory((surface, width, height) -> {
      LiveLogoProcessor processor = new LiveLogoProcessor(context, surface, width, height, 0, true,
          listener.validateSavedMediaInBackground(), error ->
              failure.compareAndSet(null, new Exception("Live watermark renderer failed. Saved footage was preserved.", error)));
      watermark.set(processor);
      encoderPrepared.countDown();
      return processor;
    });
    CountDownLatch opened = new CountDownLatch(1);
    CountDownLatch started = new CountDownLatch(1);
    CountDownLatch saved = new CountDownLatch(1);
    AtomicBoolean finishing = new AtomicBoolean(false);
    AtomicBoolean recording = new AtomicBoolean(false);
    AtomicBoolean finalized = new AtomicBoolean(false);
    UsbDevice audioCamera = context.getSystemService(UsbManager.class).getDeviceList().values().stream()
        .filter(UvcCameraRecorder::isUvcDevice).findFirst().orElse(null);
    listener.preparation("microphone_prepare");
    RecordingAudioInput audio = new RecordingAudioInput(context, audioCamera);
    listener.preparation("camera_connect");
    VideoCapture.setAudioInputCallback(recorder -> {
      try { audio.bind(recorder); }
      catch (Exception e) { failure.compareAndSet(null, e); throw e; }
    });

    ICameraHelper.StateCallback state =
        new ICameraHelper.StateCallback() {
          private void select(UsbDevice device) {
            CameraHelper helper = helperRef.get();
            if (!finishing.get() && helper != null
                && isUvcDevice(device)
                && selected.compareAndSet(null, device)) {
              Log.i(TAG, "Requesting USB permission for " + device.getDeviceName());
              helper.selectDevice(device);
            }
          }

          @Override
          public void onAttach(UsbDevice device) {
            select(device);
          }

          @Override
          public void onDeviceOpen(UsbDevice device, boolean isFirstOpen) {
            CameraHelper helper = helperRef.get();
            if (finishing.get() || helper == null) return;
            UVCParam parameters = new UVCParam();
            parameters.setQuirks(UVCCamera.getRecommendedPlatformQuirks());
            helper.openCamera(parameters);
          }

          @Override
          public void onCameraOpen(UsbDevice device) {
            Log.i(TAG, "Direct UVC camera opened: " + device.getDeviceName());
            opened.countDown();
          }

          @Override
          public void onCameraClose(UsbDevice device) {
            if (!device.equals(selected.get())) return;
            if (!finishing.get())
              failure.compareAndSet(null, new CameraCapture.Interruption(
                  CameraCapture.InterruptionCode.CAMERA_FAILURE, "The USB camera closed unexpectedly."));
            opened.countDown();
            started.countDown();
          }

          @Override
          public void onDeviceClose(UsbDevice device) {}

          @Override
          public void onDetach(UsbDevice device) {
            if (!device.equals(selected.get())) return;
            if (!finishing.get())
              failure.compareAndSet(
                  null,
                  new CameraCapture.Interruption(
                      CameraCapture.InterruptionCode.CAMERA_DISCONNECTED,
                      "The USB camera was disconnected. Reconnect it before recording again."));
            opened.countDown();
            started.countDown();
          }

          @Override
          public void onCancel(UsbDevice device) {
            failure.compareAndSet(
                null, new Exception("Allow Dink Vision to use the connected USB camera, then retry."));
            opened.countDown();
          }

          @Override
          public void onError(UsbDevice device, CameraException error) {
            failure.compareAndSet(
                null,
                new Exception(
                    "The USB camera could not be opened. Reconnect it and try another supported mode.",
                    error));
            opened.countDown();
          }
        };

    CameraHelper helper = null;
    long capturedMillis = 0;
    try {
      helper = new CameraHelper();
      helperRef.set(helper);
      helper.setStateCallback(state);
      List<UsbDevice> devices = helper.getDeviceList();
      if (devices != null)
        for (UsbDevice device : devices)
          if (isUvcDevice(device) && selected.compareAndSet(null, device)) {
            Log.i(TAG, "Selecting attached UVC camera " + device.getDeviceName());
            helper.selectDevice(device);
            break;
          }

      CameraCapture.await(
          opened,
          25,
          stop,
          failure,
          "Timed out while requesting access to the USB camera. Unplug it, reconnect it, and retry.");

      List<Size> supported = helper.getSupportedSizeList();
      if (supported == null || supported.isEmpty()) throw new Exception("The USB camera did not report its video modes.");
      listener.modes(recordingModes(supported));
      if (supported != null) for (Size offered : supported)
        if (offered.width == 1920 && offered.height == 1080)
          Log.i(TAG, "1080p camera rates=" + offered.fpsList + " encoder60=" + RecordingProfile.encoderSupports(1920,1080,60));
      Size size = chooseRecordingSize(supported, RecordingProfile::encoderSupports, max60Pixels, maxFallbackPixels, preferred);
      int fps = size.fps;
      int bitRate = RecordingProfile.bitrate(size.width, size.height, fps);
      listener.profile(size.width, size.height, fps, bitRate);
      Log.i(TAG, "Recording mode " + size.width + "x" + size.height + " fps=" + fps + " bitrate=" + bitRate);
      helper.setPreviewSize(size);
      helper.setVideoCaptureConfig(
          helper
              .getVideoCaptureConfig()
              .setVideoFrameRate(fps)
              .setBitRate(bitRate)
              .setIFrameInterval(1)
              .setAudioCaptureEnable(true)
              .setAudioBitRate(128_000)
              .setAudioSampleRate(48_000)
              .setAudioChannelCount(1));
      CountDownLatch previewFrame = new CountDownLatch(1);
      listener.preparation("camera_connect");
      helper.startPreview();
      helper.setFrameCallback(frame -> {
        if (frame != null && frame.hasRemaining()) previewFrame.countDown();
      }, UVCCamera.PIXEL_FORMAT_RAW);
      listener.camera("USB camera");
      CameraCapture.await(previewFrame, 8, stop, failure, "The USB camera opened but did not deliver video.");
      helper.setFrameCallback(null, UVCCamera.PIXEL_FORMAT_RAW);
      listener.preparation("encoder_prepare");
      CameraCapture.await(encoderPrepared, 8, stop, failure, "The USB camera encoder could not be prepared.");
      // Preserve the exposure settling time for the short calibration clip.
      if (countInSeconds == 0) {
        long warmUntil = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (!stop.getAsBoolean() && System.nanoTime() < warmUntil) {
          throwFailure(failure);
          Thread.sleep(25);
        }
      }
      CameraCapture.countIn(countInSeconds, stop, failure, listener);

      helper.startRecording(
          new VideoCapture.OutputFileOptions.Builder(file).build(),
          new VideoCapture.OnVideoCaptureCallback() {
            @Override
            public void onStart() {
              recording.set(true);
              started.countDown();
            }

            @Override
            public void onVideoSaved(VideoCapture.OutputFileResults result) {
              finalized.set(true);
              recording.set(false);
              saved.countDown();
            }

            @Override
            public void onError(int code, String message, Throwable cause) {
              recording.set(false);
              failure.compareAndSet(
                  null,
                  new Exception(
                      "The USB camera could not save a complete recording. Available footage remains on this device.",
                      cause));
              started.countDown();
              saved.countDown();
            }
          });
      CameraCapture.await(started, 15, stop, failure, "Timed out while starting the USB camera recording.");
      LiveLogoProcessor processor = watermark.get();
      if (processor == null) throw new CameraCapture.StartFailure("The USB recording surface was not prepared.");
      CameraCapture.await(processor.firstEncodedFrame, 6, stop, failure,
          "The USB camera encoder did not receive a video frame.");

      long start = System.nanoTime();
      // The driver starts the codec before attaching the camera to its input.
      listener.countdown(0);
      listener.started();
      long targetNanos = TimeUnit.SECONDS.toNanos(seconds);
      if (countInSeconds == 0 && seconds == 3) targetNanos += TimeUnit.MILLISECONDS.toNanos(350);
      CameraCapture.Interruption interruption = null;
      try {
        while (!stop.getAsBoolean() && System.nanoTime() - start < targetNanos) {
          throwFailure(failure);
          audio.observe(null, start);
          if (audio.isVerified()) listener.audio(audio.label());
          listener.frame((int) TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - start));
          if (file.getParentFile().getUsableSpace() < 50_000_000)
            throw new CameraCapture.Interruption(CameraCapture.InterruptionCode.STORAGE_FULL, "Tablet storage is nearly full.");
          Thread.sleep(100);
        }
        audio.requireVerified();
        listener.audio(audio.label());
      } catch (Exception captureFailure) {
        interruption = CameraCapture.Interruption.observed(captureFailure);
        listener.interrupted(interruption);
      }
      capturedMillis = Math.max(1, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start));
      if (interruption == null) listener.finalizing();
      finishing.set(true);
      try {
        helper.stopRecording();
        long sizeAllowance = file.length() / (32L * 1024 * 1024);
        int timeout = interruption == null ? (int) Math.min(180, 30 + sizeAllowance)
            : (int) Math.min(90, 12 + sizeAllowance);
        // A disconnect is the reason to close the file. Only the writer's
        // terminal callback, rather than a camera close notification, completes this wait.
        CameraCapture.await(saved, timeout, () -> false, new AtomicReference<>(),
            "Timed out while finalizing the USB camera recording.");
        if (!finalized.get()) {
          throwFailure(failure);
          throw new RecordingAccuracy.Failure("The USB recorder could not finalize the file.");
        }
      } catch (Exception closeFailure) {
        if (interruption == null) throw closeFailure;
        interruption.addSuppressed(closeFailure);
      }
      if (interruption != null) throw interruption;
      if (!file.isFile() || file.length() == 0)
        throw new RecordingAccuracy.Failure("The USB camera created an empty recording.");
      Log.i(TAG, "Saved direct UVC recording: " + size + ", " + file.length() + " bytes");
      return capturedMillis;
    } catch (UnsatisfiedLinkError error) {
      throw new Exception(
          "This Android processor cannot load the USB camera driver. Use a 64-bit Android device.",
          error);
    } finally {
      boolean stopAlreadyRequested = finishing.getAndSet(true);
      helperRef.set(null);
      VideoCapture.setAudioInputCallback(null);
      VideoCapture.setSurfaceProcessorFactory(null);
      if (helper != null) {
        if (recording.get() && !stopAlreadyRequested) {
          try {
            helper.stopRecording();
            saved.await(5, TimeUnit.SECONDS);
          } catch (Exception ignored) {
          }
        }
        try {
          helper.release();
        } catch (Exception ignored) {
        }
      }
    }
  }
}
