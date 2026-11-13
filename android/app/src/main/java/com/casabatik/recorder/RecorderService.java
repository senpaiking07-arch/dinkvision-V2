package com.casabatik.recorder;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import android.util.Log;

/** Protects capture independently of the background transfer service. */
public final class RecorderService extends Service {
  static final String EXTRA_CAMERA_ACTIVE = "camera-active";
  private static volatile RecorderService running;
  private PowerManager.WakeLock wake;

  static int foregroundTypes(int sdk) {
    int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        | ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
    if (sdk >= 30) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
    return types;
  }

  private Notification notification(String attempt) {
    PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    Notification.Builder builder = new Notification.Builder(this, "recording").setSmallIcon(R.drawable.ic_camera)
        .setContentTitle("Dink Vision Recorder").setContentText(attempt.isEmpty() ? "Checking the camera" : "Recording your match")
        .setContentIntent(open).setOnlyAlertOnce(true).setOngoing(true);
    if (!attempt.isEmpty()) {
      PendingIntent stop = PendingIntent.getService(this, 1,
          new Intent(this, RecorderService.class).setAction("stop")
              .setData(android.net.Uri.fromParts("capture", attempt, null)),
          PendingIntent.FLAG_IMMUTABLE);
      builder.addAction(new Notification.Action.Builder(null, "Stop recording", stop).build());
    }
    return builder.build();
  }

  @Override public void onCreate() {
    super.onCreate();
    running = this;
    getSystemService(NotificationManager.class).createNotificationChannel(
        new NotificationChannel("recording", "Match recording", NotificationManager.IMPORTANCE_LOW));
    wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "WPC:Recording");
    wake.setReferenceCounted(false);
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    Engine engine = Engine.get(this);
    if (intent != null && "stop".equals(intent.getAction())) {
      if (intent.getData() != null) engine.requestStop(intent.getData().getSchemeSpecificPart(), RecorderDiagnostics.ActionSource.NOTIFICATION);
      if (!engine.busy) stopSelf(startId);
      return START_NOT_STICKY;
    }
    try {
      Notification notice = notification(engine.captureAttempt);
      if (Build.VERSION.SDK_INT >= 29) startForeground(1, notice, foregroundTypes(Build.VERSION.SDK_INT));
      else startForeground(1, notice);
      if (!wake.isHeld()) wake.acquire(3 * 60 * 60 * 1000L);
    } catch (RuntimeException failure) {
      Log.e("DinkVisionRecorder", "Unable to start capture protection", failure);
      engine.stop = true;
      engine.error = "Open Device setup and allow camera and microphone access first.";
      stopSelf(startId);
    }
    return START_NOT_STICKY;
  }

  static boolean holdsCpuWakeLock() {
    RecorderService service = running;
    return service != null && service.wake != null && service.wake.isHeld();
  }

  static void stopWhenIdle() {
    RecorderService service = running;
    if (service == null) return;
    new Handler(Looper.getMainLooper()).post(() -> {
      if (!Engine.get(service).busy) service.stopSelf();
    });
  }

  @Override public IBinder onBind(Intent intent) { return null; }
  @Override public void onDestroy() {
    if (running == this) running = null;
    if (wake != null && wake.isHeld()) wake.release();
    super.onDestroy();
  }
}
