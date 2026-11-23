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
  @Test public void restartRecoversFinalizedMediaAndPreservesAnUnverifiedOriginal() throws Exception {
    Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
    String namespace = "capture-restart-" + UUID.randomUUID();
    String device = UUID.randomUUID().toString();
    File root = new File(base.getCacheDir(), namespace), directory = new File(root, "recordings");
    assertTrue(directory.mkdirs());
    Context context = new ContextWrapper(base) {
      @Override public Context getApplicationContext() { return this; }
      @Override public File getFilesDir() { return root; }
      @Override public File getCacheDir() { return root; }
      @Override public SharedPreferences getSharedPreferences(String name, int mode) {
        return base.getSharedPreferences(namespace + name, mode);
      }
    };
    Engine engine = null;
    File[] files = new File[3];
    JSONArray queue = new JSONArray();
    try {
      for (int index = 0; index < files.length; index++) {
        String id = UUID.randomUUID().toString();
        File file = files[index] = new File(directory, id + ".mp4");
        try (var out = new FileOutputStream(file)) { out.write(new byte[2048]); }
        if (index != 1) LiveLogoEvidence.mark(file);
        queue.put(new JSONObject().put("id", id).put("device", device).put("status", "recording")
            .put("liveLogoRequired", true).put("captureEndedNormally", index == 2));
      }
      Vault vault = new Vault(context);
      vault.put("device-id", device);
      vault.put("upload-queue", queue.toString());
      engine = new Engine(context, url -> { throw new IOException("Isolated capture restart"); });
      engine.heartbeat.shutdownNow();
      JSONArray restored = engine.vault.array("upload-queue");
      JSONObject sealed = restored.getJSONObject(0);
      assertEquals("app_interrupted", sealed.getString("captureInterruptionCode"));
      assertFalse(sealed.has("captureInterruptedAt"));
      assertEquals("pending", sealed.getString("status"));
      assertEquals(503, LocalVideoResponse.open(engine, files[0].getName(), null).getStatusCode());
      JSONObject raw = restored.getJSONObject(1);
      assertEquals("failed", raw.getString("status"));
      assertEquals(404, LocalVideoResponse.open(engine, files[1].getName(), null).getStatusCode());
      assertEquals(files[1], engine.localPlaybackFile(raw.getString("id")));
      assertEquals(2048, files[1].length());
      assertFalse(restored.getJSONObject(2).has("captureInterruptionCode"));
      assertTrue(restored.getJSONObject(2).getBoolean("validationPending"));
    } finally {
      if (engine != null) {
        engine.heartbeat.shutdownNow(); engine.work.shutdownNow(); engine.uploads.shutdownNow(); engine.exports.shutdownNow();
      }
      for (File file : files) if (file != null) file.delete();
      directory.delete();
      root.delete();
      context.getSharedPreferences("vault", 0).edit().clear().commit();
    }
  }

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
    File backup=new File(directory,present+".mp4.dinkvision.backup");
    assertTrue(original.createNewFile());
    try(FileOutputStream out=new FileOutputStream(backup)){out.write(new byte[2048]);}
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
      assertFalse("Startup restores a nonempty backup over an empty replacement", backup.exists());
      assertFalse(restored.getJSONObject(1).getBoolean("localAvailable"));
      assertEquals("failed",restored.getJSONObject(1).getString("status"));
      assertTrue(restored.getJSONObject(1).getString("lastError").contains("no longer present"));
      restored.getJSONObject(0).put("brandingState","processing");engine.vault.put("upload-queue",restored.toString());
      assertEquals(503,LocalVideoResponse.open(engine,present+".mp4",null).getStatusCode());
      restored.getJSONObject(0).put("brandingState","complete");engine.vault.put("upload-queue",restored.toString());
      assertEquals(200,LocalVideoResponse.open(engine,present+".mp4",null).getStatusCode());
    } finally {
      if(engine!=null){engine.heartbeat.shutdownNow();engine.work.shutdownNow();engine.uploads.shutdownNow();engine.exports.shutdownNow();}
      original.delete();backup.delete();directory.delete();root.delete();context.getSharedPreferences("vault",0).edit().clear().commit();
    }
  }

  @Test public void restartRevalidatesReappearingBytesAndSkipsEmptyOrphans() throws Exception {
    Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
    String namespace = "restored-file-" + UUID.randomUUID();
    String device = UUID.randomUUID().toString();
    File root = new File(base.getCacheDir(), namespace), directory = new File(root, "recordings");
    assertTrue(directory.mkdirs());
    Context context = new ContextWrapper(base) {
      @Override public Context getApplicationContext() { return this; }
      @Override public File getFilesDir() { return root; }
      @Override public File getCacheDir() { return root; }
      @Override public SharedPreferences getSharedPreferences(String name, int mode) {
        return base.getSharedPreferences(namespace + name, mode);
      }
    };
    String id = UUID.randomUUID().toString(), preparing = UUID.randomUUID().toString();
    File original = new File(directory, id + ".mp4");
    File empty = new File(directory, UUID.randomUUID() + ".mp4");
    assertTrue(empty.createNewFile());
    try (FileOutputStream out = new FileOutputStream(original)) { out.write(new byte[2048]); }
    Vault vault = new Vault(context);
    vault.put("device-id", device);
    vault.put("upload-queue", new JSONArray().put(new JSONObject()
        .put("id", id).put("device", device).put("status", "failed").put("liveLogoRequired", true)
        .put("localAvailable", false).put("validationFailed", true)
        .put("captureInterruptionCode", "app_interrupted")).toString());
    try {
      for (int restart = 0; restart < 2; restart++) {
        Engine engine = new Engine(context, url -> { throw new IOException("Isolated recovery fixture"); });
        try {
          engine.heartbeat.shutdownNow();
          JSONArray restored = engine.vault.array("upload-queue");
          assertEquals(1, restored.length());
          JSONObject item = restored.getJSONObject(0);
          assertEquals(id, item.getString("id"));
          assertEquals("pending", item.getString("status"));
          assertTrue(item.getBoolean("validationPending"));
          assertFalse(item.getBoolean("validationFailed"));
          assertEquals(503, LocalVideoResponse.open(engine, original.getName(), null).getStatusCode());
          assertEquals(2048, original.length());
          assertTrue(empty.isFile());
          if (restart == 1) {
            restored.put(new JSONObject().put("id", preparing).put("status", "recording"));
            engine.vault.put("upload-queue", restored.toString());
            engine.busy = true;
            engine.reconcileMissingLocalFiles();
            assertEquals("recording", engine.vault.array("upload-queue").getJSONObject(1).getString("status"));
          }
        } finally {
          engine.heartbeat.shutdownNow();
          engine.work.shutdownNow();
          engine.uploads.shutdownNow();
          engine.exports.shutdownNow();
        }
      }
    } finally {
      original.delete();
      empty.delete();
      new File(root, "camera-test").delete();
      directory.delete();
      root.delete();
      context.getSharedPreferences("vault", 0).edit().clear().commit();
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
      JSONArray completed = engine.vault.array("upload-queue");
      File locked = new File(files[4].getAbsolutePath()) {
        @Override public boolean delete() { return false; }
      };
      assertFalse(engine.saveVerifiedUpload(completed.getJSONObject(4), locked));
      JSONObject durable = new Vault(context).array("upload-queue").getJSONObject(4);
      assertEquals("uploaded", durable.getString("status"));
      assertTrue(durable.getBoolean("cleanupPending"));
      assertTrue(files[4].isFile());
      assertNull("A verified video is never selected for another upload", next.invoke(engine));
      engine.finishPendingUploadedCopies();
      assertFalse(files[4].exists());
      JSONObject cleaned = new Vault(context).array("upload-queue").getJSONObject(4);
      assertFalse(cleaned.getBoolean("localAvailable"));
      assertTrue(cleaned.getBoolean("presenceReportPending"));
      JSONArray interrupted = engine.vault.array("upload-queue");
      interrupted.getJSONObject(0).put("status", "failed").put("retryCount", 8);
      engine.vault.put("upload-queue", interrupted.toString());
      engine.updateServer(new JSONObject().put("enabled", true)
          .put("device", new JSONObject().put("id", deviceId))
          .put("queue", new JSONArray().put(new JSONObject().put("session_id", ids[0])
              .put("upload_state", "uploaded").put("bytes", files[0].length())
              .put("recording_sessions", new JSONObject().put("status", "ready")))));
      assertEquals("uploaded", new Vault(context).array("upload-queue").getJSONObject(0).getString("status"));
      engine.finishPendingUploadedCopies();
      assertFalse("An acknowledged final attempt is cleaned up after restart", files[0].exists());
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
      engine.server.put("capabilities", new JSONObject().put("uploadBackoffScheduling", true));
      assertEquals(restored.getJSONObject(1).getString("id"), ((JSONObject) next.invoke(engine)).getString("id"));
      restored.getJSONObject(1).put("nextQueueCheckAt", System.currentTimeMillis() + 5_000);
      engine.vault.put("upload-queue", restored.toString());
      assertNull("A waiting turn must not occupy the worker during the next probe delay", next.invoke(engine));
      restored.getJSONObject(1).put("nextQueueCheckAt", 0);
      engine.server.remove("capabilities");
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
