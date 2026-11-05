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

  private static void await(
      CountDownLatch latch,
      int seconds,
      BooleanSupplier stop,
      AtomicReference<Exception> failure,
      String timeout)
      throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
    while (latch.getCount() > 0 && System.nanoTime() < deadline) {
      throwFailure(failure);
      if (stop.getAsBoolean()) throw new Exception("Recording start was cancelled.");
      latch.await(100, TimeUnit.MILLISECONDS);
    }
    throwFailure(failure);
    if (latch.getCount() > 0) throw new Exception(timeout);
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
    VideoCapture.setSurfaceProcessorFactory((surface, width, height) ->
        new LiveLogoProcessor(context, surface, width, height, error ->
            failure.compareAndSet(null, new Exception("Live watermark renderer failed. Saved footage was preserved.", error))));
    CountDownLatch opened = new CountDownLatch(1);
    CountDownLatch started = new CountDownLatch(1);
    CountDownLatch saved = new CountDownLatch(1);
    AtomicBoolean finishing = new AtomicBoolean(false);
    AtomicBoolean recording = new AtomicBoolean(false);
    UsbDevice audioCamera = context.getSystemService(UsbManager.class).getDeviceList().values().stream()
        .filter(UvcCameraRecorder::isUvcDevice).findFirst().orElse(null);
    RecordingAudioInput audio = new RecordingAudioInput(context, audioCamera);
    VideoCapture.setAudioInputCallback(recorder -> {
      try { audio.bind(recorder); }
      catch (Exception e) { failure.compareAndSet(null, e); throw e; }
    });

    ICameraHelper.StateCallback state =
        new ICameraHelper.StateCallback() {
          private void select(UsbDevice device) {
            CameraHelper helper = helperRef.get();
            if (helper != null
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
            if (helper == null) return;
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
            if (!finishing.get())
              failure.compareAndSet(null, new Exception("The USB camera closed unexpectedly."));
            opened.countDown();
            started.countDown();
            saved.countDown();
          }

          @Override
          public void onDeviceClose(UsbDevice device) {}

          @Override
          public void onDetach(UsbDevice device) {
            if (device.equals(selected.get()) && !finishing.get())
              failure.compareAndSet(
                  null,
                  new Exception(
                      "The USB camera was disconnected. Reconnect it before recording again."));
            opened.countDown();
            started.countDown();
            saved.countDown();
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

      await(
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
      helper.startPreview();
      listener.camera("USB camera");
      // Match captures already warm the camera during the three-second countdown.
      // Calibration has no countdown: let USB exposure/stream delivery settle first.
      if (countInSeconds == 0) {
        long warmUntil = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (!stop.getAsBoolean() && System.nanoTime() < warmUntil) {
          throwFailure(failure);
          Thread.sleep(25);
        }
      }
      listener.ready();

      for (int value = countInSeconds; value > 0; value--) {
        listener.countdown(value);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
        while (!stop.getAsBoolean() && System.nanoTime() < deadline) {
          throwFailure(failure);
          Thread.sleep(25);
        }
      }
      if (stop.getAsBoolean()) throw new Exception("Recording start was cancelled.");

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
      await(started, 15, stop, failure, "Timed out while starting the USB camera recording.");

      long start = System.nanoTime();
      // onStart is the first reliable signal that the USB capture is live.
      listener.countdown(0);
      listener.started();
      long targetNanos = TimeUnit.SECONDS.toNanos(seconds);
      if (countInSeconds == 0 && seconds == 3) targetNanos += TimeUnit.MILLISECONDS.toNanos(350);
      while (!stop.getAsBoolean()
          && System.nanoTime() - start < targetNanos) {
        throwFailure(failure);
        audio.observe(null, start);
        if (audio.isVerified()) listener.audio(audio.label());
        listener.frame((int) TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - start));
        if (file.getParentFile().getUsableSpace() < 50_000_000)
          throw new Exception("Tablet storage is nearly full.");
        Thread.sleep(100);
      }
      capturedMillis = Math.max(1, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start));
      audio.requireVerified();
      listener.audio(audio.label());
      listener.finalizing();
      finishing.set(true);
      helper.stopRecording();
      await(saved, (int)Math.min(180, 30 + file.length() / (32L * 1024 * 1024)), () -> false, failure, "Timed out while finalizing the USB camera recording.");
      throwFailure(failure);
      if (!file.isFile() || file.length() == 0)
        throw new RecordingAccuracy.Failure("The USB camera created an empty recording.");
      Log.i(TAG, "Saved direct UVC recording: " + size + ", " + file.length() + " bytes");
      return capturedMillis;
    } catch (UnsatisfiedLinkError error) {
      throw new Exception(
          "This Android processor cannot load the USB camera driver. Use a 64-bit Android device.",
          error);
    } finally {
      finishing.set(true);
      VideoCapture.setAudioInputCallback(null);
      VideoCapture.setSurfaceProcessorFactory(null);
      if (helper != null) {
        if (recording.get()) {
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
