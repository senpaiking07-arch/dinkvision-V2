package com.casabatik.recorder;

import static org.junit.Assert.*;
import org.junit.Test;
import org.junit.Assume;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.core.app.ActivityScenario;
import java.io.*;

/** Explicitly requested diagnostic only: never enrolls, uploads, emails or touches the real queue. */
public class LiveLogoCameraTest {
  @Test public void consecutiveUsbRecordingsContainLiveLogo() throws Exception {
    Assume.assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("liveUsbCamera")));
    var context=InstrumentationRegistry.getInstrumentation().getTargetContext();
    assertTrue("Run only in the separate diagnostic package",context.getPackageName().endsWith(".honor"));
    Engine engine=Engine.get(context);
    try(var activity=ActivityScenario.launch(MainActivity.class);
        PrintWriter log=new PrintWriter(new File(context.getCacheDir(),"live-camera-results.txt"))) {
      engine.busy=true;engine.phase="testing";engine.startService(true,false);
      for(int index=1;index<=3;index++) {
        File file=new File(context.getCacheDir(),"live-camera-"+index+".mp4");
        final int clip=index;
        long start=System.nanoTime();
        long captured=UvcCameraRecorder.capture(context,file,65,3,()->false,new CameraCapture.Listener(){
          public void ready() { log.println("ready clip="+clip);log.flush(); }
          public void countdown(int value) {}
          public void started() { log.println("started clip="+clip);log.flush(); }
          public void frame(int seconds) {}
          public void audio(String label) { engine.recordingAudioInput=label; }
          public void profile(int w,int h,int fps,int bitrate) { log.println("profile="+w+"x"+h+" target="+fps+" bitrate="+bitrate);log.flush(); }
        },Long.MAX_VALUE,Long.MAX_VALUE,"1920x1080@60");
        long validated=RecordedVideo.validate(file,captured,true);
        assertTrue("Saved USB video must have validated live-logo evidence",LiveLogoEvidence.verified(file));
        long before=file.length(),brandStart=System.nanoTime();
        VideoBranding.apply(context,file,captured,true,()->false);
        assertEquals(before,file.length());
        log.println("completed clip="+clip+" captureMs="+captured+" validatedMs="+validated+" actualFps="+RecordedVideo.measuredFrameRate(file)
            +" bytes="+before+" elapsedSeconds="+(System.nanoTime()-start)/1e9+" brandingCheckSeconds="+(System.nanoTime()-brandStart)/1e9+" audio="+engine.recordingAudioInput);
        log.flush();
      }
    } finally { engine.busy=false;engine.phase="idle";RecorderService.stopWhenIdle(); }
  }

  @Test public void shortUsbCaptureWithLiveLogo() throws Exception {
    var instrumentation = InstrumentationRegistry.getInstrumentation();
    Assume.assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("shortUsbCamera")));
    var context = instrumentation.getTargetContext();
    assertTrue("Run only in the local test package", context.getPackageName().endsWith(".dev"));
    assertTrue("Connect a UVC camera before starting the test", UvcCameraRecorder.hasAttachedCamera(context));
    instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), android.Manifest.permission.CAMERA);
    instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), android.Manifest.permission.RECORD_AUDIO);
    if (android.os.Build.VERSION.SDK_INT >= 33)
      instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), android.Manifest.permission.POST_NOTIFICATIONS);
    File file = File.createTempFile("usb-smoke-", ".mp4", context.getCacheDir());
    assertTrue(file.delete());
    Engine engine = Engine.get(context);
    var countdown = new java.util.ArrayList<Integer>();
    var audio = new java.util.concurrent.atomic.AtomicReference<String>();
    engine.busy = true;
    try (var activity = ActivityScenario.launch(MainActivity.class)) {
      activity.onActivity(a -> engine.startService(true, false));
      long duration = UvcCameraRecorder.capture(context, file, 3, 3, () -> false, new CameraCapture.Listener() {
        public void ready() {}
        public void countdown(int value) { countdown.add(value); }
        public void started() {}
        public void frame(int seconds) {}
        public void audio(String label) { audio.set(label); }
      });
      assertEquals(java.util.Arrays.asList(3, 2, 1, 0), countdown);
      LiveLogoEvidence.requireVerified(file);
      long playableMs = RecordedVideo.validate(file, duration, true);
      assertTrue("Expected a three-second playable clip", playableMs >= 2_900);
      assertNotNull("Report the microphone route", audio.get());
      System.out.println("Local USB capture duration=" + playableMs
          + " ms, measured fps=" + RecordedVideo.measuredFrameRate(file) + ", " + audio.get());
    } finally {
      engine.busy = false;
      RecorderService.stopWhenIdle();
      file.delete();
    }
  }

  /** Operator unplugs the camera after the started signal. This never creates a server session. */
  @Test public void usbDisconnectThenBuiltInCapture() throws Exception {
    Assume.assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("unplugCamera")));
    var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    assertTrue(context.getPackageName().endsWith(".honor"));
    Engine engine = Engine.get(context);
    File interrupted = new File(context.getCacheDir(), "unplug-" + System.currentTimeMillis() + ".mp4");
    try (var activity = ActivityScenario.launch(MainActivity.class);
         PrintWriter log = new PrintWriter(new File(context.getCacheDir(), "unplug-test.txt"))) {
      engine.busy = true;
      engine.phase = "testing";
      engine.startService(true, false);
      var listener = new CameraCapture.Listener() {
        public void ready() {}
        public void countdown(int value) {}
        public void started() { log.println("capture started"); log.flush(); }
        public void frame(int seconds) {}
        public void audio(String label) { engine.recordingAudioInput = label; }
      };
      try {
        UvcCameraRecorder.capture(context, interrupted, 300, 0, () -> false, listener);
        fail("Expected physical USB disconnection");
      } catch (Exception disconnected) {
        assertFalse("Camera must have been physically removed", UvcCameraRecorder.hasAttachedCamera(context));
        log.println("USB interrupted: " + disconnected.getMessage() + "; private bytes=" + interrupted.length());
        log.flush();
      }
      File builtin = new File(context.getCacheDir(), "built-in-live.mp4");
      long duration = DeviceCameraRecorder.capture(context, builtin, 5, 0, () -> false, listener);
      LiveLogoEvidence.requireVerified(builtin);
      RecordedVideo.validate(builtin, duration, true);
      log.println("Built-in capture ms=" + duration + " fps=" + RecordedVideo.measuredFrameRate(builtin)
          + " audio=" + engine.recordingAudioInput);
    } finally { engine.busy = false; engine.phase = "idle"; RecorderService.stopWhenIdle(); }
  }
}
