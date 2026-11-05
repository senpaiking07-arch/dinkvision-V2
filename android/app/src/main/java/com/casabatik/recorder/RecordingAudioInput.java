package com.casabatik.recorder;

import android.content.Context;
import android.hardware.usb.UsbDevice;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.util.Log;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Selects the camera microphone and verifies the live input, rather than the preference alone. */
final class RecordingAudioInput {
  private final AudioManager manager;
  private final AudioDeviceInfo expected;
  private boolean verified;
  private boolean legacyRouteUnreported;
  private volatile AudioRecord boundRecorder;
  private long lastObserved;

  RecordingAudioInput(Context context, UsbDevice camera) throws Exception {
    manager = context.getSystemService(AudioManager.class);
    if (manager == null) throw new Exception("Android audio is unavailable.");
    List<AudioDeviceInfo> usb = new ArrayList<>();
    AudioDeviceInfo builtIn = null;
    for (AudioDeviceInfo input : manager.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
      if (isUsb(input.getType())) usb.add(input);
      else if (input.getType() == AudioDeviceInfo.TYPE_BUILTIN_MIC && builtIn == null) builtIn = input;
    }
    AudioDeviceInfo selected = null;
    if (camera != null) {
      for (AudioDeviceInfo input : usb) {
        if (sameProduct(camera.getProductName(), String.valueOf(input.getProductName()))) {
          if (selected != null) throw new Exception("More than one camera microphone is connected. Keep only the recording camera attached.");
          selected = input;
        }
      }
      // Product labels are OEM-dependent. A single USB input is unambiguous when the
      // selected camera exposes a USB Audio interface (including composite webcams).
      if (selected == null && hasAudioInterface(camera) && usb.size() == 1) selected = usb.get(0);
      if (selected == null && hasAudioInterface(camera) && !usb.isEmpty())
        throw new Exception("The camera microphone could not be identified. Disconnect other USB audio devices and test again.");
    }
    expected = selected != null ? selected : builtIn;
    if (expected == null) throw new Exception("No recording microphone is available. Reconnect the camera and test again.");
  }

  static boolean isUsb(int type) {
    return type == AudioDeviceInfo.TYPE_USB_DEVICE || type == AudioDeviceInfo.TYPE_USB_HEADSET;
  }

  static boolean sameProduct(String camera, String microphone) {
    if (camera == null || microphone == null) return false;
    String a = camera.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
    String b = microphone.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
    return a.length() >= 4 && b.contains(a);
  }

  private static boolean hasAudioInterface(UsbDevice camera) {
    for (int i = 0; i < camera.getInterfaceCount(); i++)
      if (camera.getInterface(i).getInterfaceClass() == android.hardware.usb.UsbConstants.USB_CLASS_AUDIO) return true;
    return false;
  }

  void prefer(MediaRecorder recorder) throws Exception {
    if (Build.VERSION.SDK_INT >= 28 && !recorder.setPreferredDevice(expected))
      throw new Exception("Android could not select the recording microphone. Reconnect the camera and test again.");
  }

  void bind(AudioRecord recorder) throws Exception {
    if (!recorder.setPreferredDevice(expected))
      throw new Exception("Android could not select the camera microphone. Reconnect the camera and test again.");
    boundRecorder = recorder;
  }

  String label() {
    String source=isUsb(expected.getType()) ? "Camera microphone: " + expected.getProductName() : "Phone/tablet microphone";
    return legacyRouteUnreported ? source + " (routing not reported by Android 8)" : source;
  }

  boolean isVerified() { return verified || legacyRouteUnreported; }

  private void check(AudioDeviceInfo actual, boolean silenced) throws Exception {
    if (silenced) throw new Exception("Android muted the recording microphone. Close other camera or calling apps, then test again.");
    if (actual == null) return;
    if (actual.getId() != expected.getId())
      throw new Exception(isUsb(expected.getType())
          ? "Android is not using the camera microphone. Reconnect the camera, check that Disable USB audio routing is off in Developer options, then test again."
          : "Android changed the recording microphone. Disconnect other audio devices and test again.");
    if (!verified) Log.i("DinkVision-Audio", "Verified input: " + label());
    verified = true;
  }

  void observe(MediaRecorder recorder, long captureStartNanos) throws Exception {
    long now = System.nanoTime();
    if (now - lastObserved < 200_000_000L) return;
    lastObserved = now;
    if (recorder != null && Build.VERSION.SDK_INT >= 28) check(recorder.getRoutedDevice(), false);
    else if (recorder != null) {
      // MediaRecorder exposes routing only from API 28. Do not reject Android 8
      // solely for lacking that API, and do not describe its policy route as verified.
      for (var configuration : manager.getActiveRecordingConfigurations())
        if (configuration.getAudioDevice() != null) check(configuration.getAudioDevice(), false);
      legacyRouteUnreported = !verified;
    }
    else if (boundRecorder != null) {
      var configuration = Build.VERSION.SDK_INT >= 29 ? boundRecorder.getActiveRecordingConfiguration() : null;
      check(boundRecorder.getRoutedDevice(), Build.VERSION.SDK_INT >= 29 && configuration != null && configuration.isClientSilenced());
    }
    if (!isVerified() && now - captureStartNanos > 1_500_000_000L)
      throw new Exception("Android did not confirm a recording microphone. Reconnect the camera and test again.");
  }

  void requireVerified() throws Exception {
    if (!isVerified()) throw new Exception("The recording microphone could not be verified. Record another camera test.");
  }
}
