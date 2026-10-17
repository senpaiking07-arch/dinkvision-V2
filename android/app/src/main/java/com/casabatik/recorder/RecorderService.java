package com.casabatik.recorder;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import android.util.Log;

public final class RecorderService extends Service {
  private static final String TAG = "DinkVisionRecorder";
  private static volatile RecorderService running;
  static final String EXTRA_CAMERA_ACTIVE = "camera-active";
  static final String EXTRA_UPLOAD_ACTIVE = "upload-active";
  private PowerManager.WakeLock wake;
  private Notification notification;

  static int foregroundTypes(
      int sdk, boolean deviceCamera, boolean cameraActive, boolean uploadActive) {
    int types = 0;
    if (cameraActive && deviceCamera) {
      types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
      if (sdk >= 30) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
    }
    if (uploadActive) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
    if (types == 0) types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
    return types;
  }

  @Override
  public void onCreate() {
    super.onCreate();
    running = this;
    NotificationManager manager = getSystemService(NotificationManager.class);
    manager.createNotificationChannel(
        new NotificationChannel(
            "recording", "Match recording", NotificationManager.IMPORTANCE_LOW));
    PendingIntent open =
        PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    PendingIntent stop =
        PendingIntent.getService(
            this,
            1,
            new Intent(this, RecorderService.class).setAction("stop"),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    notification =
        new Notification.Builder(this, "recording")
            .setSmallIcon(com.casabatik.recorder.R.drawable.ic_camera)
            .setContentTitle("Dink Vision Recorder")
            .setContentText("Recording or uploading your match")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(new Notification.Action.Builder(null, "Stop recording", stop).build())
            .build();
    // Android starts the foreground-service timeout before onStartCommand. Promote the service
    // immediately with the permission-safe connected-device type, then narrow/update the type
    // from the actual work flags in onStartCommand.
    if (Build.VERSION.SDK_INT >= 29)
      startForeground(
          1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
    else startForeground(1, notification);
    wake =
        getSystemService(PowerManager.class)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "WPC:Recording");
    wake.acquire(3 * 60 * 60 * 1000L);
  }

  @Override
  public int onStartCommand(Intent i, int f, int id) {
    if (i != null && "stop".equals(i.getAction())) Engine.get(this).stop = true;
    boolean cameraActive = i != null && i.getBooleanExtra(EXTRA_CAMERA_ACTIVE, false);
    boolean uploadActive = i != null && i.getBooleanExtra(EXTRA_UPLOAD_ACTIVE, false);
    try {
      if (Build.VERSION.SDK_INT >= 29)
        startForeground(
            1,
            notification,
            foregroundTypes(
                Build.VERSION.SDK_INT,
                Engine.get(this).usesDeviceCamera(),
                cameraActive,
                uploadActive));
      else startForeground(1, notification);
    } catch (RuntimeException failure) {
      Log.e(TAG, "Unable to update foreground service type", failure);
      Engine.get(this).stop = true;
      Engine.get(this).error =
          cameraActive
              ? "Open Device setup and allow camera and microphone access first."
              : "Android could not start the background upload service. Reopen the app and retry.";
      stopSelf(id);
      return START_NOT_STICKY;
    }
    Engine engine = Engine.get(this);
    if (!engine.busy && !engine.uploadWorkerRunning.get()) stopSelf(id);
    return START_NOT_STICKY;
  }

  static void stopWhenIdle() {
    RecorderService service = running;
    if (service != null) service.stopSelf();
  }

  @Override
  public IBinder onBind(Intent i) {
    return null;
  }

  @Override
  public void onDestroy() {
    if (running == this) running = null;
    if (wake != null && wake.isHeld()) wake.release();
    super.onDestroy();
  }
}
