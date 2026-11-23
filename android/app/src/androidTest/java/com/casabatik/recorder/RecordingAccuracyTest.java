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
    var countdown = new java.util.ArrayList<Integer>();
    var readyAt = new java.util.concurrent.atomic.AtomicLong();
    var startedAt = new java.util.concurrent.atomic.AtomicLong();
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
                      3,
                      () -> false,
                      new CameraCapture.Listener() {
                        public void ready() { readyAt.set(System.nanoTime()); }

                        public void countdown(int value) { countdown.add(value); }

                        public void started() {
                          startedAt.set(System.nanoTime());
                          started.countDown();
                        }

                        public void frame(int seconds) {}

                        public boolean validateSavedMediaInBackground() { return true; }
                      }));
      assertTrue("Camera did not start", started.await(15, TimeUnit.SECONDS));
      assertEquals(java.util.Arrays.asList(3, 2, 1, 0), countdown);
      assertTrue("Recording started before the ready countdown completed",
          startedAt.get() - readyAt.get() >= TimeUnit.SECONDS.toNanos(3));
      boolean exerciseTimeout = "true".equals(InstrumentationRegistry.getArguments().getString("transferTimeout"));
      if (exerciseTimeout) {
        activity.onActivity(a -> engine.startService(false, true));
        long readyDeadline = System.nanoTime() + 5_000_000_000L;
        while (!TransferService.isReady() && System.nanoTime() < readyDeadline) Thread.sleep(25);
        assertTrue(TransferService.isReady());
      }
      activity.moveToState(androidx.lifecycle.Lifecycle.State.CREATED);
      instrumentation.getUiAutomation().executeShellCommand("input keyevent 223").close();
      screenSleeping = true;
      Thread.sleep(1_500);
      if (exerciseTimeout) {
        var running = TransferService.class.getDeclaredField("running");
        running.setAccessible(true);
        TransferService service = (TransferService) running.get(null);
        instrumentation.runOnMainSync(() -> service.onTimeout(1, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC));
        assertTrue(engine.backgroundTransfers.isPaused());
        assertFalse(engine.stop);
      }
      assertTrue("Foreground service lost its CPU wake lock", RecorderService.holdsCpuWakeLock());
      long duration = result.get(20, TimeUnit.SECONDS);
      LiveLogoEvidence.requireVerified(file);
      RecordedVideo.validate(file, duration, true);
    } finally {
      if (screenSleeping)
        try {
          instrumentation.getUiAutomation().executeShellCommand("input keyevent 224").close();
        } catch (Exception ignored) {
        }
      engine.busy = false;
      engine.backgroundTransfers.foregroundEntered();
      context.stopService(new android.content.Intent(context, TransferService.class));
      context.stopService(new android.content.Intent(context, RecorderService.class));
      capture.shutdownNow();
      file.delete();
    }
  }
  @Test public void duplicateStartAndStaleStopDoNotChangeTheActiveCapture() {
    var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    Engine engine = Engine.get(context);
    try {
      engine.busy = true;
      engine.stop = false;
      engine.phase = "recording";
      engine.captureAttempt = "current-capture";
      engine.start("invalid duplicate payload", System.nanoTime());
      assertEquals("recording", engine.phase);
      engine.requestStop("previous-capture");
      assertFalse(engine.stop);
      engine.requestStop("current-capture");
      assertTrue(engine.stop);
      assertEquals("finalizing", engine.phase);
      engine.message = "Saving the complete video…";
      engine.requestStop("current-capture");
      assertEquals("Saving the complete video…", engine.message);
    } finally {
      engine.captureAttempt = "";
      engine.phase = "idle";
      engine.stop = false;
      engine.busy = false;
    }
  }
  @Test public void leavingCancelsPreparationAndPreservesAnActiveRecording() {
    Engine engine = Engine.get(InstrumentationRegistry.getInstrumentation().getTargetContext());
    boolean wasVisible = engine.visible;
    try {
      engine.busy = true;
      engine.captureAttempt = "test-attempt";
      for (String phase : new String[]{"connecting", "countdown", "recording"}) {
        engine.visible = true;
        engine.stop = false;
        engine.phase = phase;
        engine.leavePlayerWorkflow();
        assertFalse(engine.visible);
        assertEquals(!"recording".equals(phase), engine.stop);
      }
      engine.busy = false;
      engine.phase = "idle";
      engine.start("invalid delayed start", System.nanoTime());
      assertEquals("idle", engine.phase);
    } finally {
      engine.visible = wasVisible;
      engine.busy = false;
      engine.stop = false;
      engine.phase = "idle";
      engine.captureAttempt = "";
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

  @Test public void interruptedDeviceCaptureFinalizesAvailableTracksAndReleasesTheCamera() throws Exception {
    var instrumentation = InstrumentationRegistry.getInstrumentation();
    var context = instrumentation.getTargetContext();
    instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), android.Manifest.permission.CAMERA);
    instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), android.Manifest.permission.RECORD_AUDIO);
    File partial = new File(context.getCacheDir(), "interrupted-camera.mp4");
    File next = new File(context.getCacheDir(), "next-camera.mp4");
    Engine engine = Engine.get(context);
    engine.busy = true;
    try (var activity = androidx.test.core.app.ActivityScenario.launch(MainActivity.class)) {
      activity.onActivity(a -> engine.startService(true, false));
      var interrupted = new java.util.concurrent.atomic.AtomicReference<CameraCapture.Interruption>();
      assertThrows(CameraCapture.Interruption.class,
          () -> DeviceCameraRecorder.capture(context, partial, 15, 0, () -> false, new CameraCapture.Listener() {
            public void ready() {}
            public void countdown(int value) {}
            public void started() {}
            public void frame(int seconds) {
              if (seconds >= 2) throw new IllegalStateException("Injected interruption");
            }
            public void interrupted(CameraCapture.Interruption reason) { interrupted.set(reason); }
            public boolean validateSavedMediaInBackground() { return true; }
          }));
      assertEquals(CameraCapture.InterruptionCode.UNKNOWN, interrupted.get().code);
      LiveLogoEvidence.requireVerified(partial);
      long recovered = RecordedVideo.validate(partial, -1, true);
      assertTrue("Recovered actual duration: " + recovered, recovered > 1000 && recovered < 4000);
      long duration = DeviceCameraRecorder.capture(context, next, 3, 0, () -> false, new CameraCapture.Listener() {
        public void ready() {}
        public void countdown(int value) {}
        public void started() {}
        public void frame(int seconds) {}
        public boolean validateSavedMediaInBackground() { return true; }
      });
      RecordedVideo.validate(next, duration, true);
    } finally {
      engine.busy = false;
      context.stopService(new android.content.Intent(context, RecorderService.class));
      partial.delete();
      next.delete();
    }
  }
}
