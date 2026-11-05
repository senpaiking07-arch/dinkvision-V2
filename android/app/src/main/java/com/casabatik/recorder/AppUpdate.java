package com.casabatik.recorder;

import android.net.Uri;
import org.json.JSONObject;

/** Only the configured application backend supplies update policy; JS never supplies a URL. */
final class AppUpdate {
  static JSONObject validate(JSONObject value) throws Exception {
    int code = value.getInt("versionCode");
    String name = value.getString("versionName");
    boolean required = value.getBoolean("required");
    String url = value.getString("downloadUrl");
    if (code < 1 || !name.matches("[0-9]+\\.[0-9]+\\.[0-9]+") || name.length() > 32)
      throw new Exception("Invalid Android update version.");
    if ((!url.isEmpty() && !safeDownloadUrl(url)) || (required && url.isEmpty()))
      throw new Exception("The Android update download is unavailable. Contact your administrator.");
    return new JSONObject().put("versionCode", code).put("versionName", name)
        .put("required", required).put("downloadUrl", url);
  }

  static boolean safeDownloadUrl(String raw) {
    try {
      Uri uri = Uri.parse(raw);
      return raw.length() <= 2048 && "https".equals(uri.getScheme()) && uri.getHost() != null
          && !uri.getHost().isEmpty() && uri.getUserInfo() == null && uri.getFragment() == null;
    } catch (Exception e) { return false; }
  }

  static boolean required(JSONObject policy, int installedCode) {
    return policy.optBoolean("required") && policy.optInt("versionCode") > installedCode;
  }
}
