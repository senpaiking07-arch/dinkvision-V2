package com.casabatik.recorder;

import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.util.concurrent.*;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class RecordingAccuracyTest {
  @Test public void deviceCameraPreservesElapsedTime() throws Exception {
    var instrumentation = InstrumentationRegistry.getInstrumentation();
    var context = instrumentation.getTargetContext();
    instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), android.Manifest.permission.CAMERA);
    instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), android.Manifest.permission.RECORD_AUDIO);
    File file = new File(context.getCacheDir(), "device-clock.mp4");
    Engine engine = Engine.get(context);
    ExecutorService capture = Executors.newSingleThreadExecutor();
    CountDownLatch started = new CountDownLatch(1);
    boolean screenSleeping = false;
    engine.busy = true;
    try (var activity = androidx.test.core.app.ActivityScenario.launch(MainActivity.class)) {
      context.startForegroundService(
          new android.content.Intent(context, RecorderService.class)
              .putExtra(RecorderService.EXTRA_CAMERA_ACTIVE, true));
      Future<Long> result =
          capture.submit(
              () ->
                  DeviceCameraRecorder.capture(
                      context,
                      file,
                      6,
                      0,
                      () -> false,
                      new CameraCapture.Listener() {
                        public void ready() {}

                        public void countdown(int value) {}

                        public void started() {
                          started.countDown();
                        }

                        public void frame(int seconds) {}
                      }));
      assertTrue("Camera did not start", started.await(15, TimeUnit.SECONDS));
      activity.moveToState(androidx.lifecycle.Lifecycle.State.CREATED);
      instrumentation.getUiAutomation().executeShellCommand("input keyevent 223").close();
      screenSleeping = true;
      Thread.sleep(1_500);
      assertTrue("Foreground service lost its CPU wake lock", RecorderService.holdsCpuWakeLock());
      long duration = result.get(20, TimeUnit.SECONDS);
      RecordedVideo.validate(file, duration, true);
    } finally {
      if (screenSleeping)
        try {
          instrumentation.getUiAutomation().executeShellCommand("input keyevent 224").close();
        } catch (Exception ignored) {
        }
      engine.busy = false;
      context.stopService(new android.content.Intent(context, RecorderService.class));
      capture.shutdownNow();
      file.delete();
    }
  }
  @Test public void incompleteAudioCannotPassRecoveryValidation() throws Exception {
    var instrumentation = InstrumentationRegistry.getInstrumentation();
    File file = new File(instrumentation.getTargetContext().getCacheDir(), "bad-timing.mp4");
    try {
      try (InputStream in = instrumentation.getContext().getAssets().open("mismatched-tracks.mp4");
          OutputStream out = new FileOutputStream(file)) { in.transferTo(out); }
      try { RecordedVideo.validate(file, -1, true); fail("Recovery must reject mismatched tracks"); }
      catch (RecordingAccuracy.Failure expected) {}
    } finally { file.delete(); }
  }
}
