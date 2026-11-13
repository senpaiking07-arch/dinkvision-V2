package com.casabatik.recorder;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.*;

/** Owns transfer protection independently of camera capture. */
public final class TransferService extends Service {
  private static volatile TransferService running;
  private final Handler main = new Handler(Looper.getMainLooper());
  private PowerManager.WakeLock wake;
  private WifiManager.WifiLock wifi;
  private volatile boolean ready;
  private boolean stopping;
  private int uploadPercent = -1, brandingPercent = -1, exportPercent = -1;

  static boolean isReady() {
    TransferService service = running;
    return service != null && service.ready;
  }

  static void updateUploadProgress(int percent) {
    update(service -> { service.brandingPercent = -1; service.uploadPercent = percent; });
  }
  static void updateBrandingProgress(int percent) {
    update(service -> service.brandingPercent = Math.max(0, Math.min(99, percent)));
  }
  static void finishBranding() { update(service -> service.brandingPercent = -1); }
  static void updateExportProgress(int percent) { update(service -> service.exportPercent = percent); }
  static void finishExport() { update(service -> service.exportPercent = -1); }

  private static void update(java.util.function.Consumer<TransferService> change) {
    TransferService service = running;
    if (service == null) return;
    service.main.post(() -> {
      if (!service.ready || service.stopping) return;
      change.accept(service);
      if (!service.wake.isHeld()) service.wake.acquire(3 * 60 * 60 * 1000L);
      service.getSystemService(NotificationManager.class).notify(2, service.notification());
    });
  }

  private Notification notification() {
    Engine engine = Engine.get(this);
    String detail = "Preparing saved video";
    int percent = uploadPercent;
    if (exportPercent >= 0) {
      detail = "Saving video to device"; percent = exportPercent;
    } else if (brandingPercent >= 0) {
      detail = "Adding logo"; percent = brandingPercent;
    } else if (uploadPercent >= 0) detail = "Uploading saved video";
    else if (engine.hasWaitingUploadTurn()) detail = "Waiting to upload saved video";
    else if (engine.hasRetryingUpload()) detail = "Upload retry scheduled";
    PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    return new Notification.Builder(this, "transfers")
        .setSmallIcon(R.drawable.ic_camera).setContentTitle("DinkVision saved videos")
        .setContentText(detail + (percent >= 0 ? " · " + percent + "%" : ""))
        .setContentIntent(open).setOnlyAlertOnce(true).setOngoing(true)
        .setProgress(100, Math.max(0, percent), percent < 0).build();
  }

  @Override public void onCreate() {
    super.onCreate();
    running = this;
    getSystemService(NotificationManager.class).createNotificationChannel(
        new NotificationChannel("transfers", "Saved video transfers", NotificationManager.IMPORTANCE_LOW));
    wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "WPC:Transfers");
    wake.setReferenceCounted(false);
    wifi = getSystemService(WifiManager.class).createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "WPC:Transfers");
    wifi.setReferenceCounted(false);
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    Engine engine = Engine.get(this);
    try {
      if (Build.VERSION.SDK_INT >= 29)
        startForeground(2, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
      else startForeground(2, notification());
      if (engine.backgroundTransfers.isPaused()) {
        stopTransferService();
        return START_NOT_STICKY;
      }
      ready = true;
      if (!wake.isHeld()) wake.acquire(3 * 60 * 60 * 1000L);
      if (!wifi.isHeld()) wifi.acquire();
    } catch (RuntimeException denied) {
      engine.pauseBackgroundTransfers();
      stopTransferService();
    }
    return START_NOT_STICKY;
  }

  @Override public void onTimeout(int startId, int type) {
    Engine.get(this).pauseBackgroundTransfers();
    stopTransferService();
  }

  private void stopTransferService() {
    stopping = true;
    ready = false;
    stopForeground(STOP_FOREGROUND_REMOVE);
    stopSelf();
  }

  static void stopWhenIdle() {
    TransferService service = running;
    if (service == null) return;
    service.main.post(() -> {
      Engine engine = Engine.get(service);
      if (!engine.uploadWorkerRunning.get() && !engine.exportWorkerRunning.get()
          && !engine.hasPendingUploadWork()) service.stopTransferService();
    });
  }

  @Override public IBinder onBind(Intent intent) { return null; }

  @Override public void onDestroy() {
    ready = false;
    if (running == this) running = null;
    Engine engine = Engine.get(this);
    // A new request can race an idle stop. Its worker must wait for a new foreground service.
    if (!stopping || engine.uploadWorkerRunning.get() || engine.exportWorkerRunning.get())
      engine.pauseBackgroundTransfers();
    main.removeCallbacksAndMessages(null);
    if (wifi != null && wifi.isHeld()) wifi.release();
    if (wake != null && wake.isHeld()) wake.release();
    super.onDestroy();
  }
}
