package com.casabatik.recorder;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class UploadFailureRecoveryTest {
  @Test public void failedReportIsDurableAndOnlyANewerAdminRetryRestartsIt() throws Exception {
    Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
    String namespace = "failure-report-test-" + UUID.randomUUID();
    String device = UUID.randomUUID().toString(), session = UUID.randomUUID().toString();
    File root = new File(base.getCacheDir(), namespace);
    File directory = new File(root, "recordings");
    assertTrue(directory.mkdirs());
    File footage = new File(directory, session + ".mp4");
    try (FileOutputStream output = new FileOutputStream(footage)) { output.write(new byte[2048]); }
    Context context = new ContextWrapper(base) {
      public Context getApplicationContext() { return this; }
      public File getFilesDir() { return root; }
      public File getCacheDir() { return root; }
      public SharedPreferences getSharedPreferences(String name, int mode) {
        return base.getSharedPreferences(namespace + name, mode);
      }
    };
    Vault vault = new Vault(context);
    vault.put("upload-queue", new JSONArray().put(new JSONObject()
        .put("id", session).put("device", device).put("status", "failed")
        .put("localAvailable", true).put("retryCount", 1).put("validationFailed", true)
        .put("brandingState", "failed").put("failureReportPending", true)).toString());
    Engine engine = new Engine(context, url -> new HttpURLConnection(url) {
      public void connect() {}
      public void disconnect() {}
      public boolean usingProxy() { return false; }
      public java.io.OutputStream getOutputStream() { return new ByteArrayOutputStream(); }
      public int getResponseCode() { return 200; }
      public java.util.Map<String,java.util.List<String>> getHeaderFields() { return Collections.emptyMap(); }
      public java.io.InputStream getInputStream() {
        return new ByteArrayInputStream(
            "{\"ok\":true,\"upload_state\":\"failed\",\"upload_updated_at\":\"2026-11-01T00:00:00+00:00\"}"
                .getBytes(StandardCharsets.UTF_8));
      }
    });
    engine.heartbeat.shutdownNow();
    try {
      JSONObject remote = new JSONObject().put("session_id", session).put("upload_state", "retrying")
          .put("upload_updated_at", "2026-11-01T00:00:00.000Z");
      engine.server = new JSONObject().put("device", new JSONObject().put("id", device))
          .put("queue", new JSONArray().put(remote));
      var reconcile = Engine.class.getDeclaredMethod("reconcileServerUploadRequests");
      reconcile.setAccessible(true);
      reconcile.invoke(engine);
      assertEquals("failed", engine.vault.array("upload-queue").getJSONObject(0).getString("status"));
      var report = Engine.class.getDeclaredMethod("reportPendingUploadFailures");
      report.setAccessible(true);
      report.invoke(engine);
      assertFalse(engine.vault.array("upload-queue").getJSONObject(0).getBoolean("failureReportPending"));
      reconcile.invoke(engine);
      assertEquals("failed", engine.vault.array("upload-queue").getJSONObject(0).getString("status"));
      remote.put("upload_updated_at", "2026-11-01T00:00:01.000Z");
      reconcile.invoke(engine);
      JSONObject restarted = engine.vault.array("upload-queue").getJSONObject(0);
      assertEquals("pending", restarted.getString("status"));
      assertEquals(0, restarted.getInt("retryCount"));
      assertEquals(2048, footage.length());
    } finally {
      engine.heartbeat.shutdownNow(); engine.work.shutdownNow(); engine.uploads.shutdownNow();
      context.getSharedPreferences("vault", 0).edit().clear().commit();
      footage.delete(); directory.delete(); new File(root, "camera-test").delete(); root.delete();
    }
  }
}
