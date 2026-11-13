package com.casabatik.recorder;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class CameraTestRecoveryTest {
  @Test public void activityRecreationPreservesApprovalUntilTheCameraReconnects() throws Exception {
    var instrumentation = InstrumentationRegistry.getInstrumentation();
    Context context = instrumentation.getTargetContext();
    instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), android.Manifest.permission.CAMERA);
    instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), android.Manifest.permission.RECORD_AUDIO);
    if (android.os.Build.VERSION.SDK_INT >= 33)
      instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), android.Manifest.permission.POST_NOTIFICATIONS);
    Engine engine=Engine.get(context);assertFalse("Do not interrupt an active capture",engine.busy);
    boolean original=engine.cameraCheckedThisLaunch;String connection=engine.confirmedCameraConnection;
    try(var activity=androidx.test.core.app.ActivityScenario.launch(MainActivity.class)){
      engine.cameraCheckedThisLaunch=true;engine.confirmedCameraConnection=UvcCameraRecorder.connectionKey(context);
      activity.recreate();
      assertTrue("Recreating the screen must not reset the current process camera approval",engine.cameraCheckedThisLaunch);
      engine.cameraConnectionChanged();assertFalse("A real reconnect must still require a fresh test",engine.cameraCheckedThisLaunch);
    }finally{engine.cameraCheckedThisLaunch=original;engine.confirmedCameraConnection=connection;}
  }
  @Test public void staleConfirmationDoesNotTrapRecordAnotherTest() throws Exception {
    checkReviewRecovery(false);
  }

  @Test public void failedConfirmationKeepsTheClipAvailableForAnotherConfirmation() throws Exception {
    checkReviewRecovery(true);
  }

  private void checkReviewRecovery(boolean accepting) throws Exception {
    checkReviewRecovery(accepting, false);
  }

  @Test public void changingModeInvalidatesNativeConfirmationEvenAfterSwitchingBack() throws Exception {
    checkReviewRecovery(true, true);
  }

  private void checkReviewRecovery(boolean accepting, boolean changeMode) throws Exception {
    Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
    String namespace = "camera-review-test-" + UUID.randomUUID();
    File root = new File(base.getCacheDir(), namespace);
    assertTrue(root.mkdirs());
    Context context = new ContextWrapper(base) {
      public Context getApplicationContext() { return this; }
      public File getFilesDir() { return root; }
      public File getCacheDir() { return root; }
      public SharedPreferences getSharedPreferences(String name, int mode) {
        return base.getSharedPreferences(namespace + name, mode);
      }
    };
    Engine engine = new Engine(context, url -> new HttpURLConnection(url) {
      public void connect() {}
      public void disconnect() {}
      public boolean usingProxy() { return false; }
      public java.io.OutputStream getOutputStream() { return new ByteArrayOutputStream(); }
      public int getResponseCode() { return url.getPath().endsWith("/camera") ? 409 : 200; }
      public java.util.Map<String,java.util.List<String>> getHeaderFields() { return Collections.emptyMap(); }
      public java.io.InputStream getErrorStream() {
        return bytes("{\"error\":\"Camera settings changed during the test. Tap Record another test.\"}");
      }
      public java.io.InputStream getInputStream() {
        return bytes("{\"enabled\":true,\"device\":{\"video_device\":\"\"}}");
      }
      private ByteArrayInputStream bytes(String text) {
        return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8));
      }
    });
    engine.heartbeat.shutdownNow();
    assertFalse("A new process starts without camera approval",engine.cameraCheckedThisLaunch);
    try {
      engine.visible = true;
      engine.phase = "review";
      engine.cameraTestReady = true;
      engine.cameraTestRevision = UUID.randomUUID().toString();
      engine.cameraTestCamera = "{}";
      engine.cameraTestMode = engine.selectedModeKey;
    engine.cameraTestConnection = UvcCameraRecorder.connectionKey(context);
    engine.cameraTestGeneration = engine.cameraConnectionGeneration;
      engine.vault.put("camera", "old camera");
      engine.vault.put("camera-revision", "old revision");
      if (changeMode) {
        assertTrue(engine.canConfirmCameraTest());
        engine.cameraTestToken = "current-test";
        engine.confirmCameraTestRequest(new JSONObject().put("mode","auto").put("token","stale-test").toString());
        assertFalse(engine.busy);
        assertTrue(engine.error.contains("test changed"));
        engine.recordingModes = new org.json.JSONArray().put(new JSONObject().put("key", "1920x1080-60").put("supported", true));
        assertTrue(engine.selectRecordingMode("1920x1080-60"));
        assertFalse(engine.canConfirmCameraTest());
        assertTrue(engine.selectRecordingMode("auto"));
        assertFalse(engine.canConfirmCameraTest());
        engine.confirmCameraTest(true, false);
        assertFalse(engine.busy);
        assertTrue(engine.error.contains("Record another test"));
        engine.cameraTestMode = "auto";
        engine.cameraTestGeneration--;
        assertFalse(engine.canConfirmCameraTest());
        return;
      }
      engine.confirmCameraTest(accepting, !accepting);
      engine.work.submit(() -> {}).get(5, TimeUnit.SECONDS);
      assertFalse(engine.busy);
      assertEquals(accepting, engine.cameraTestReady);
      if (accepting) {
        assertEquals("review", engine.phase);
        assertTrue(engine.error.contains("Record another test"));
      } else {
        assertEquals("idle", engine.phase);
        assertEquals("", engine.vault.get("camera"));
        assertEquals("", engine.vault.get("camera-revision"));
      }
    } finally {
      engine.heartbeat.shutdownNow();
      engine.work.shutdownNow();
      engine.uploads.shutdownNow();
      context.getSharedPreferences("vault", 0).edit().clear().commit();
      new File(root, "camera-test").delete();
      root.delete();
    }
  }
}
