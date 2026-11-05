package com.casabatik.recorder;

import static org.junit.Assert.*;
import android.media.AudioDeviceInfo;
import org.junit.Test;

public class RecordingAudioInputTest {
  @Test public void usbMicrophonesAreDistinctFromPhoneBluetoothAndPlaybackDevices() {
    assertTrue(RecordingAudioInput.isUsb(AudioDeviceInfo.TYPE_USB_DEVICE));
    assertTrue(RecordingAudioInput.isUsb(AudioDeviceInfo.TYPE_USB_HEADSET));
    assertFalse(RecordingAudioInput.isUsb(AudioDeviceInfo.TYPE_BUILTIN_MIC));
    assertFalse(RecordingAudioInput.isUsb(AudioDeviceInfo.TYPE_BLUETOOTH_SCO));
  }

  @Test public void cameraProductMatchingToleratesUsbPrefixesButNotAnUnrelatedMicrophone() {
    assertTrue(RecordingAudioInput.sameProduct("EMEET SmartCam C60E 4K", "USB-Audio - EMEET SmartCam C60E 4K"));
    assertTrue(RecordingAudioInput.sameProduct("Logitech C920", "Logitech-C920"));
    assertFalse(RecordingAudioInput.sameProduct("EMEET SmartCam C60E 4K", "USB Headset"));
    assertFalse(RecordingAudioInput.sameProduct(null, "USB Headset"));
  }
}
