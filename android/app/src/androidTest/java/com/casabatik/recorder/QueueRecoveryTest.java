package com.casabatik.recorder;

import static org.junit.Assert.*;
import android.content.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.util.UUID;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class QueueRecoveryTest {
  @Test public void interruptedBrandingResumesButMissingOriginalIsReportedUnavailable() throws Exception {
    Context base=InstrumentationRegistry.getInstrumentation().getTargetContext();
    String namespace="branding-recovery-"+UUID.randomUUID(), device=UUID.randomUUID().toString();
    File root=new File(base.getCacheDir(),namespace), directory=new File(root,"recordings");
    assertTrue(directory.mkdirs());
    Context context=new ContextWrapper(base) {
      public Context getApplicationContext(){return this;}
      public File getFilesDir(){return root;}
      public SharedPreferences getSharedPreferences(String name,int mode){return base.getSharedPreferences(namespace+name,mode);}
    };
    String present=UUID.randomUUID().toString(), missing=UUID.randomUUID().toString();
    File original=new File(directory,present+".mp4");
    try(FileOutputStream out=new FileOutputStream(original)){out.write(new byte[2048]);}
    Vault vault=new Vault(context);
    JSONArray jobs=new JSONArray();
    for(String id:new String[]{present,missing}) jobs.put(new JSONObject().put("id",id).put("device",device)
        .put("status","saved_locally").put("brandingState","processing").put("localAvailable",true).put("retryCount",3));
    vault.put("upload-queue",jobs.toString());Engine engine=null;
    try {
      engine=new Engine(context,url->{throw new IOException("Isolated fixture cannot access the network");});
      engine.heartbeat.shutdownNow();engine.server=new JSONObject().put("device",new JSONObject().put("id",device));
      JSONArray restored=engine.vault.array("upload-queue");
      assertEquals("saved_locally",restored.getJSONObject(0).getString("status"));
      assertFalse("A stale processing flag must be cleared at restart", "processing".equals(restored.getJSONObject(0).optString("brandingState")));
      assertEquals(3,restored.getJSONObject(0).getInt("retryCount"));assertEquals(2048,original.length());
      assertFalse(restored.getJSONObject(1).getBoolean("localAvailable"));
      assertEquals("failed",restored.getJSONObject(1).getString("status"));
      assertTrue(restored.getJSONObject(1).getString("lastError").contains("no longer present"));
      restored.getJSONObject(0).put("brandingState","processing");engine.vault.put("upload-queue",restored.toString());
      assertEquals(503,LocalVideoResponse.open(engine,present+".mp4",null).getStatusCode());
      restored.getJSONObject(0).put("brandingState","complete");engine.vault.put("upload-queue",restored.toString());
      assertEquals(200,LocalVideoResponse.open(engine,present+".mp4",null).getStatusCode());
    } finally {
      if(engine!=null){engine.heartbeat.shutdownNow();engine.work.shutdownNow();engine.uploads.shutdownNow();engine.exports.shutdownNow();}
      original.delete();directory.delete();root.delete();context.getSharedPreferences("vault",0).edit().clear().commit();
    }
  }
  @Test public void fivePendingUploadsRemainFifoAndKeepTheirFiles() throws Exception {
    Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
    String namespace = "five-upload-test-" + UUID.randomUUID();
    String deviceId = UUID.randomUUID().toString();
    File root = new File(base.getCacheDir(), namespace);
    Context context = new ContextWrapper(base) {
      public Context getApplicationContext() { return this; }
      public File getFilesDir() { return root; }
      public SharedPreferences getSharedPreferences(String name, int mode) {
        return base.getSharedPreferences(namespace + name, mode);
      }
    };
    File directory = new File(root, "recordings");
    assertTrue(directory.mkdirs());
    JSONArray jobs = new JSONArray();
    File[] files = new File[5];
    String[] ids = new String[5];
    Engine engine = null;
    try {
      for (int index = 0; index < 5; index++) {
        ids[index] = UUID.randomUUID().toString();
        files[index] = new File(directory, ids[index] + ".mp4");
        try (FileOutputStream out = new FileOutputStream(files[index])) {
          out.write(new byte[] {(byte) index, 1, 2, 3});
        }
        jobs.put(new JSONObject()
            .put("id", ids[index])
            .put("device", deviceId)
            .put("status", "pending")
            .put("retryCount", 0)
            .put("createdAt", index)
            .put("localAvailable", true));
      }
      Vault vault = new Vault(context);
      vault.put("upload-queue", jobs.toString());
      engine = new Engine(context);
      engine.heartbeat.shutdownNow();
      engine.server = new JSONObject().put("device", new JSONObject().put("id", deviceId));
      var next = Engine.class.getDeclaredMethod("nextUpload");
      next.setAccessible(true);
      for (int index = 0; index < 5; index++) {
        JSONObject selected = (JSONObject) next.invoke(engine);
        assertNotNull(selected);
        assertEquals(ids[index], selected.getString("id"));
        assertEquals(4, files[index].length());
        JSONArray current = engine.vault.array("upload-queue");
        current.getJSONObject(index).put("status", "uploaded");
        engine.vault.put("upload-queue", current.toString());
      }
      assertNull(next.invoke(engine));
    } finally {
      if (engine != null) {
        engine.heartbeat.shutdownNow();
        engine.work.shutdownNow();
        engine.uploads.shutdownNow();
      }
      for (File file : files) if (file != null) file.delete();
      directory.delete();
      root.delete();
      context.getSharedPreferences("vault", 0).edit().clear().commit();
    }
  }

  @Test public void restartRestoresUploadsWithoutDeletingFootageOrResettingRetries() throws Exception {
    Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
    String namespace = "queue-test-" + UUID.randomUUID();
    String deviceId = UUID.randomUUID().toString();
    File root = new File(base.getCacheDir(), namespace);
    Context context = new ContextWrapper(base) {
      public Context getApplicationContext() { return this; }
      public File getFilesDir() { return root; }
      public SharedPreferences getSharedPreferences(String name, int mode) {
        return base.getSharedPreferences(namespace + name, mode);
      }
    };
    File directory = new File(root, "recordings");
    assertTrue(directory.mkdirs());
    JSONArray jobs = new JSONArray();
    String[] states = {"uploading", "recording", "local_only", "failed", "uploaded", "retrying"};
    File[] files = new File[states.length];
    Engine engine = null;
    try {
      for (int i = 0; i < states.length; i++) {
        String id = UUID.randomUUID().toString();
        files[i] = new File(directory, id + ".mp4");
        try (FileOutputStream out = new FileOutputStream(files[i])) { out.write(new byte[2048]); }
        jobs.put(new JSONObject().put("id", id).put("device", deviceId).put("status", states[i]).put("retryCount", 7)
            .put("createdAt", i).put("nextRetryAt", states[i].equals("retrying") ? System.currentTimeMillis()+60000 : 0)
            .put("localAvailable", true));
      }
      Vault vault = new Vault(context);
      vault.put("upload-queue", jobs.toString());
      engine = new Engine(context);
      engine.heartbeat.shutdownNow();
      engine.server = new JSONObject().put("device", new JSONObject().put("id", deviceId));
      JSONArray restored = new Vault(context).array("upload-queue");
      for (int i = 0; i < states.length; i++) {
        assertEquals(2048, files[i].length());
        assertEquals(i == 0 ? 8 : 7, restored.getJSONObject(i).getInt("retryCount"));
        assertEquals(i == 0 ? "failed" : i == 1 ? "pending" : states[i], restored.getJSONObject(i).getString("status"));
      }
      // Simulate the restored head backing off: another eligible item wins.
      restored.getJSONObject(0).put("status", "retrying").put("nextRetryAt", System.currentTimeMillis()+60000);
      engine.vault.put("upload-queue", restored.toString());
      var next = Engine.class.getDeclaredMethod("nextUpload"); next.setAccessible(true);
      assertEquals(restored.getJSONObject(1).getString("id"), ((JSONObject)next.invoke(engine)).getString("id"));
      // A completed logo may already own the server upload turn. Waiting for
      // that retry must not occupy the only worker behind its own FIFO head.
      restored.getJSONObject(0).put("branded", true);
      engine.vault.put("upload-queue", restored.toString());
      assertNull(next.invoke(engine));
      assertEquals(8, restored.getJSONObject(0).getInt("retryCount"));
      restored.getJSONObject(0).put("nextRetryAt", 0);
      engine.vault.put("upload-queue", restored.toString());
      assertEquals(restored.getJSONObject(0).getString("id"), ((JSONObject)next.invoke(engine)).getString("id"));
      restored.getJSONObject(0).put("branded", false).put("nextRetryAt", System.currentTimeMillis()+60000);
      engine.vault.put("upload-queue", restored.toString());
      // Re-enrollment must not process or reset a different device's saved jobs.
      restored.getJSONObject(1).put("device", UUID.randomUUID().toString());
      engine.vault.put("upload-queue", restored.toString());
      assertNull(next.invoke(engine));
      try {engine.localPlaybackFile(restored.getJSONObject(1).getString("id"));fail("Foreign-device local playback must be denied");}
      catch(Exception expected){assertTrue(expected.getMessage().contains("playable"));}
      engine.retryUpload(restored.getJSONObject(1).getString("id"));
      assertEquals(7, engine.vault.array("upload-queue").getJSONObject(1).getInt("retryCount"));
      restored.getJSONObject(1).put("device", deviceId);
      // A stale pre-failure server poll cannot grant a new retry budget.
      restored.getJSONObject(3).put("failureServerUpdatedAt", "2026-10-13T12:00:00Z");
      engine.vault.put("upload-queue", restored.toString());
      assertEquals(files[1],engine.localPlaybackFile(restored.getJSONObject(1).getString("id")));
      JSONObject remote = new JSONObject().put("session_id", restored.getJSONObject(3).getString("id"))
          .put("upload_state", "retrying").put("retry_count", 0).put("last_error", "")
          .put("upload_updated_at", "2026-10-13T11:59:00Z");
      engine.server.put("queue", new JSONArray().put(remote));
      var reconcile = Engine.class.getDeclaredMethod("reconcileServerUploadRequests"); reconcile.setAccessible(true);
      reconcile.invoke(engine);
      assertEquals("failed", engine.vault.array("upload-queue").getJSONObject(3).getString("status"));
      remote.put("upload_updated_at", "2026-10-13T12:01:00Z");
      reconcile.invoke(engine);
      assertEquals("pending", engine.vault.array("upload-queue").getJSONObject(3).getString("status"));
    } finally {
      if (engine != null) { engine.heartbeat.shutdownNow(); engine.work.shutdownNow(); engine.uploads.shutdownNow(); }
      // Only this test's synthetic files are removed.
      for (File file : files) if (file != null) file.delete();
      directory.delete(); root.delete();
      context.getSharedPreferences("vault", 0).edit().clear().commit();
    }
  }
}
