package com.casabatik.recorder;

import android.net.Uri;
import java.net.URI;

final class EnrollmentLink {
  private EnrollmentLink() {}

  static boolean pairingCode(String value) {
    return value.matches("[A-Za-z0-9_-]{12}");
  }

  static String scanned(String value) {
    return scanned(value, true);
  }

  static boolean forAnotherServer(String value) {
    return !scanned(value, false).isEmpty() && scanned(value).isEmpty();
  }

  private static String scanned(String value, boolean requireSameServer) {
    if (value == null || value.length() > 512) return "";
    try {
      URI link = new URI(value);
      URI app = URI.create(Api.ORIGIN);
      if (link.getHost() == null || link.getUserInfo() != null
          || !("https".equals(link.getScheme()) || "http".equals(link.getScheme()))
          || !"/tablet/enroll".equals(link.getRawPath()))
        return "";
      if (requireSameServer
          && (!app.getScheme().equals(link.getScheme()) || !app.getAuthority().equals(link.getAuthority())))
        return "";
      String query = link.getRawQuery();
      String fragment = link.getRawFragment();
      if (query == null && fragment != null && fragment.startsWith("code=") && pairingCode(fragment.substring(5)))
        return fragment.substring(5);
      return fragment == null && query != null && query.matches("invite=[A-Za-z0-9_-]{24}") ? query.substring(7) : "";
    } catch (Exception invalid) {
      return "";
    }
  }

  static String handoff(Uri link) {
    if (link == null || !"dinkvision-recorder".equals(link.getScheme())
        || !"enroll".equals(link.getEncodedAuthority()) || link.getEncodedQuery() != null
        || link.getEncodedFragment() != null) return "";
    String path = link.getEncodedPath();
    return path != null && path.matches("/(?:[A-Za-z0-9_-]{12}|[A-Za-z0-9_-]{24})") ? path.substring(1) : "";
  }
}
