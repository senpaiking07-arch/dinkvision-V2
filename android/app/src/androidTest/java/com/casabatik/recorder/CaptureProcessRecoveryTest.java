package com.casabatik.recorder;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

import android.Manifest;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.IOException;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Host-driven emulator test. Stop the process after capturing appears, then invoke with phase=verify. */
public class CaptureProcessRecoveryTest {
  @Test public void interruptedProcess() throws Exception {
    var instrumentation = InstrumentationRegistry.getInstrumentation();
    Context base = instrumentation.getTargetContext();
    var args = InstrumentationRegistry.getArguments();
    String run = args.getString("recoveryRun", "");
    assumeTrue(!run.isEmpty() && base.getPackageName().endsWith(".dev"));
    String id = UUID.fromString(run).toString();
    String namespace = "capture-process-" + id;
    File root = new File(base.getFilesDir(), namespace);
    File directory = new File(root, "recordings");
    File file = new File(directory, id + ".mp4");
    File capturing = new File(root, "capturing");
    Context isolated = new ContextWrapper(base) {
      public Context getApplicationContext() { return this; }
      public File getFilesDir() { return root; }
      public SharedPreferences getSharedPreferences(String name, int mode) {
        return base.getSharedPreferences(namespace + name, mode);
      }
    };
    if ("verify".equals(args.getString("phase"))) {
      assertTrue(capturing.isFile());
      Engine recovered = new Engine(isolated, url -> { throw new IOException("Offline recovery test"); });
      try {
        for (int pass = 0; pass < 2; pass++) {
          recovered.reconcileMissingLocalFiles();
          JSONArray items = new JSONObject(recovered.snapshot()).getJSONArray("savedVideos");
          assertEquals(1, items.length());
          JSONObject item = items.getJSONObject(0);
          assertEquals(id, item.getString("id"));
          assertEquals("app_interrupted", item.getString("captureInterruptionCode"));
          assertTrue(item.getBoolean("validationFailed"));
          assertEquals(file.length() > 0, item.getBoolean("localAvailable"));
          android.util.Log.i("RecoveryTest", "Original bytes retained: " + file.length());
        }
      } finally {
        recovered.heartbeat.shutdownNow(); recovered.work.shutdownNow();
        recovered.uploads.shutdownNow(); recovered.exports.shutdownNow();
        file.delete(); capturing.delete(); directory.delete(); root.delete();
        base.deleteSharedPreferences(namespace + "vault");
      }
      return;
    }
    assertEquals("capture", args.getString("phase"));
    assertTrue(directory.mkdirs());
    Vault vault = new Vault(isolated);
    vault.put("device-id", id);
    vault.put("upload-queue", new JSONArray().put(new JSONObject().put("id", id)
        .put("device", id).put("status", "recording").put("liveLogoRequired", true)).toString());
    instrumentation.getUiAutomation().grantRuntimePermission(base.getPackageName(), Manifest.permission.CAMERA);
    instrumentation.getUiAutomation().grantRuntimePermission(base.getPackageName(), Manifest.permission.RECORD_AUDIO);
    try (var activity = ActivityScenario.launch(MainActivity.class)) {
      activity.onActivity(a -> Engine.get(base).startService(true, false));
      DeviceCameraRecorder.capture(base, file, 90, 0, () -> false, new CameraCapture.Listener() {
        public void ready() {}
        public void countdown(int value) {}
        public void started() {}
        public void frame(int seconds) {
          if (seconds >= 3 && !capturing.exists()) try { capturing.createNewFile(); }
          catch (IOException e) { throw new IllegalStateException(e); }
        }
      });
      fail("Host did not interrupt the capture within 90 seconds.");
    }
  }
}
