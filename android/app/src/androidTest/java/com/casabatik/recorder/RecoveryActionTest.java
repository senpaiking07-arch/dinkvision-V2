package com.casabatik.recorder;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class RecoveryActionTest {
  @Test
  public void failedLocalCaptureOffersRecoveryForCurrentDeviceOnly() throws Exception {
    Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
    String namespace = "recovery-action-" + UUID.randomUUID();
    File root = new File(base.getCacheDir(), namespace);
    Context context = new ContextWrapper(base) {
      @Override public Context getApplicationContext() { return this; }
      @Override public File getFilesDir() { return root; }
      @Override public SharedPreferences getSharedPreferences(String name, int mode) {
        return base.getSharedPreferences(namespace + name, mode);
      }
    };
    String device = UUID.randomUUID().toString();
    String ownId = UUID.randomUUID().toString();
    String otherId = UUID.randomUUID().toString();
    File directory = new File(root, "recordings");
    assertTrue(directory.mkdirs());
    File ownFile = new File(directory, ownId + ".mp4");
    File otherFile = new File(directory, otherId + ".mp4");
    Engine engine = null;
    try {
      for (File file : new File[] {ownFile, otherFile}) {
        try (FileOutputStream output = new FileOutputStream(file)) {
          output.write(new byte[2048]);
        }
      }
      JSONArray jobs = new JSONArray()
          .put(new JSONObject().put("id", ownId).put("device", device)
              .put("status", "failed").put("retryCount", 3)
              .put("createdAt", 1).put("localAvailable", true))
          .put(new JSONObject().put("id", otherId).put("device", UUID.randomUUID().toString())
              .put("status", "failed").put("createdAt", 2).put("localAvailable", true));
      new Vault(context).put("upload-queue", jobs.toString());
      engine = new Engine(context);
      engine.heartbeat.shutdownNow();
      engine.server = new JSONObject().put("device", new JSONObject().put("id", device));

      JSONObject before = new JSONObject(engine.snapshot());
      assertTrue(before.getBoolean("recoverable"));
      assertEquals("partial", before.getString("recoveryKind"));
      engine.retryLatestFailedUpload();

      JSONArray after = engine.vault.array("upload-queue");
      assertEquals("pending", after.getJSONObject(0).getString("status"));
      assertEquals(0, after.getJSONObject(0).getInt("retryCount"));
      assertEquals("failed", after.getJSONObject(1).getString("status"));
      assertTrue(ownFile.isFile());
      assertTrue(otherFile.isFile());
      assertFalse(new JSONObject(engine.snapshot()).getBoolean("recoverable"));
      assertEquals(ownId, engine.latestSavedSession);
      assertEquals("complete", engine.phase);
      assertFalse(engine.hasRetryingUpload());
      after.getJSONObject(0).put("status", "retrying");
      engine.vault.put("upload-queue", after.toString());
      assertTrue(engine.hasRetryingUpload());
    } finally {
      if (engine != null) {
        engine.heartbeat.shutdownNow();
        engine.work.shutdownNow();
        engine.uploads.shutdownNow();
      }
      ownFile.delete();
      otherFile.delete();
      directory.delete();
      root.delete();
      context.getSharedPreferences("vault", 0).edit().clear().commit();
    }
  }
}
