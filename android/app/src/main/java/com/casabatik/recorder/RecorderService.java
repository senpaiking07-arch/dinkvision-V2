package com.casabatik.recorder;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;

public final class RecorderService extends Service {
  private PowerManager.WakeLock wake;

  @Override
  public void onCreate() {
    super.onCreate();
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
    Notification n =
        new Notification.Builder(this, "recording")
            .setSmallIcon(com.casabatik.recorder.R.drawable.ic_camera)
            .setContentTitle("WPC Recorder")
            .setContentText("Recording or uploading your match")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(new Notification.Action.Builder(null, "Stop recording", stop).build())
            .build();
    if (Build.VERSION.SDK_INT >= 29) {
      int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
      if (Engine.get(this).usesDeviceCamera())
        type |=
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                | ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
      startForeground(1, n, type);
    }
    else startForeground(1, n);
    wake =
        getSystemService(PowerManager.class)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "WPC:Recording");
    wake.acquire(3 * 60 * 60 * 1000L);
  }

  @Override
  public int onStartCommand(Intent i, int f, int id) {
    if (i != null && "stop".equals(i.getAction())) Engine.get(this).stop = true;
    return START_NOT_STICKY;
  }

  @Override
  public IBinder onBind(Intent i) {
    return null;
  }

  @Override
  public void onDestroy() {
    if (wake != null && wake.isHeld()) wake.release();
    super.onDestroy();
  }
}
