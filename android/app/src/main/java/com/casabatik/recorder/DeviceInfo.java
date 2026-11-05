package com.casabatik.recorder;

import android.content.Context;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONObject;

/** Non-unique inventory only: never reports serial numbers, accounts, or credentials. */
final class DeviceInfo {
  private DeviceInfo() {}
  private static String label(String value, String fallback) {
    if (value == null || value.trim().isEmpty()) return fallback;
    String clean = value.replaceAll("\\p{Cntrl}", " ").trim();
    return clean.isEmpty() ? fallback : clean.substring(0, Math.min(80, clean.length()));
  }
  static JSONObject report(Context context) throws Exception {
    return report(context, "");
  }
  static JSONObject report(Context context, String microphone) throws Exception {
    return report(context, microphone, "");
  }
  static JSONObject report(Context context, String microphone, String profile) throws Exception {
    JSONArray cameras = new JSONArray();
    UsbManager manager = context.getSystemService(UsbManager.class);
    if (manager != null) for (UsbDevice device : manager.getDeviceList().values()) {
      if (cameras.length() >= 4) break;
      if (!UvcCameraRecorder.isUvcDevice(device)) continue;
      cameras.put(new JSONObject().put("name", label(device.getProductName(), "USB camera"))
          .put("manufacturer", label(device.getManufacturerName(), "Unknown"))
          .put("vendor_id", device.getVendorId()).put("product_id", device.getProductId()));
    }
    JSONObject report = new JSONObject().put("platform", "android").put("manufacturer", label(Build.MANUFACTURER, "Unknown"))
        .put("model", label(Build.MODEL, "Unknown")).put("android_version", Build.VERSION.RELEASE)
        .put("android_sdk", Build.VERSION.SDK_INT).put("app_version", BuildConfig.VERSION_NAME)
        .put("app_version_code", BuildConfig.VERSION_CODE).put("usb_cameras", cameras);
    if (microphone != null && !microphone.isEmpty()) report.put("microphone_input", microphone.substring(0, Math.min(160, microphone.length())));
    if (profile != null && !profile.isEmpty()) report.put("recording_profile", profile.substring(0, Math.min(160, profile.length())));
    return report;
  }
}
