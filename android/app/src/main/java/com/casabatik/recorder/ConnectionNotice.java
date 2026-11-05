package com.casabatik.recorder;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;

final class ConnectionNotice {
  static String message(Context context, Boolean serverReachable) {
    ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
    NetworkCapabilities network = manager == null ? null : manager.getNetworkCapabilities(manager.getActiveNetwork());
    return message(network != null && network.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED), serverReachable);
  }

  static String message(boolean internetValidated, Boolean serverReachable) {
    if (!internetValidated) return "No internet connection detected. Saved videos will wait for reconnection.";
    if (Boolean.FALSE.equals(serverReachable)) return "Internet available, but the application server cannot be reached. Retrying automatically.";
    return "";
  }
}
