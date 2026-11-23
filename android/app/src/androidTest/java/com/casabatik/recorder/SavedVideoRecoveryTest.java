package com.casabatik.recorder;

import static org.junit.Assert.*;

import android.content.*;
import android.net.Uri;
import android.provider.MediaStore;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class SavedVideoRecoveryTest {
  private static final class Fixture implements AutoCloseable {
    final Context context;
    final File root, directory;
    final String device = UUID.randomUUID().toString();
    final Engine engine;
    final List<File> files = new ArrayList<>();
    final List<Uri> copies = new ArrayList<>();
    Fixture() throws Exception { this(null); }
    Fixture(Api.Connections connections) throws Exception {
      Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
      String namespace = "saved-video-test-" + UUID.randomUUID();
      root = new File(base.getCacheDir(), namespace);
      directory = new File(root, "recordings");
      assertTrue(directory.mkdirs());
      context = new ContextWrapper(base) {
        public Context getApplicationContext() { return this; }
        public File getFilesDir() { return root; }
        public File getCacheDir() { return root; }
        public SharedPreferences getSharedPreferences(String name, int mode) {
          return base.getSharedPreferences(namespace + name, mode);
        }
      };
      engine = new Engine(context, connections);
      engine.heartbeat.shutdownNow();
      engine.updateServer(new JSONObject().put("enabled", true).put("device", new JSONObject().put("id", device)));
      engine.server = new JSONObject(); // Recovered identity remains usable with no connection.
    }
    String add(String owner, String status) throws Exception {
      String id = UUID.randomUUID().toString();
      File file = new File(directory, id + ".mp4");
      byte[] bytes = new byte[2048];
      for (int i = 0; i < bytes.length; i++) bytes[i] = (byte)i;
      Files.write(file.toPath(), bytes); files.add(file);
      JSONArray queue = engine.vault.array("upload-queue");
      queue.put(new JSONObject().put("id", id).put("device", owner).put("status", status)
          .put("createdAt", System.currentTimeMillis()).put("localAvailable", true)
          .put("retryCount", 8).put("nextRetryAt", 9999999999999L));
      engine.vault.put("upload-queue", queue.toString());
      return id;
    }
    JSONObject item(String id) throws Exception {
      JSONArray items = engine.vault.array("upload-queue");
      for (int i = 0; i < items.length(); i++) if (id.equals(items.getJSONObject(i).getString("id"))) return items.getJSONObject(i);
      throw new AssertionError("Missing fixture item");
    }
    void exportGallery(String id) throws Exception {
      try (var activity = ActivityScenario.launch(MainActivity.class)) {
        activity.onActivity(ignored -> engine.exportLocalVideo(id, null));
        engine.exports.submit(() -> {}).get(15, TimeUnit.SECONDS);
        assertEquals("", engine.localVideoError);
      }
    }
    public void close() throws Exception {
      for (Uri uri : copies) if (LocalVideoExporter.readable(context.getContentResolver(), uri.toString()))
        context.getContentResolver().delete(uri, null, null);
      engine.heartbeat.shutdownNow(); engine.work.shutdownNow(); engine.uploads.shutdownNow(); engine.exports.shutdownNow();
      for (File file : files) file.delete();
      directory.delete(); new File(root, "camera-test").delete(); root.delete();
      context.getSharedPreferences("vault", 0).edit().clear().commit();
    }
  }

  @Test public void offlineLibrarySeparatesDevicesAndRetryKeepsItsOriginal() throws Exception {
    try (Fixture f = new Fixture()) {
      String own = f.add(f.device, "failed"), queued = f.add(f.device, "pending");
      String foreignDevice = UUID.randomUUID().toString(), foreign = f.add(foreignDevice, "failed");
      String recording = f.add(f.device, "recording");
      JSONArray saved = new JSONObject(f.engine.snapshot()).getJSONArray("savedVideos");
      assertEquals(2, saved.length());
      byte[] original = Files.readAllBytes(f.engine.localPlaybackFile(own).toPath());
      f.engine.retryUpload(own);
      assertEquals("pending", f.item(own).getString("status"));
      assertEquals(0, f.item(own).getInt("retryCount"));
      assertEquals(0, f.item(own).getLong("nextRetryAt"));
      assertArrayEquals(original, Files.readAllBytes(f.engine.localPlaybackFile(own).toPath()));
      f.engine.retryUpload(foreign);
      assertEquals("failed", f.item(foreign).getString("status"));
      assertThrows(Exception.class, () -> f.engine.localPlaybackFile(recording));
      f.engine.updateServer(new JSONObject().put("enabled", true).put("device", new JSONObject().put("id", foreignDevice)));
      assertEquals(1, new JSONObject(f.engine.snapshot()).getJSONArray("savedVideos").length());
      assertThrows(Exception.class, () -> f.engine.localPlaybackFile(queued));
      f.engine.updateServer(new JSONObject().put("enabled", false));
      assertEquals(0, new JSONObject(f.engine.snapshot()).getJSONArray("savedVideos").length());
      assertTrue(new File(f.directory, own + ".mp4").isFile());
    }
  }

  @Test public void galleryExportPreservesTheOriginalAndAnExplicitSecondSaveCreatesANewCopy() throws Exception {
    org.junit.Assume.assumeTrue(android.os.Build.VERSION.SDK_INT >= 29);
    try (Fixture f = new Fixture()) {
      String id = f.add(f.device, "failed");
      byte[] original = Files.readAllBytes(f.engine.localPlaybackFile(id).toPath());
      f.exportGallery(id);
      Uri uri = Uri.parse(f.item(id).getString("exportedUri")); f.copies.add(uri);
      try (InputStream copy = f.context.getContentResolver().openInputStream(uri)) {
        assertArrayEquals(original, copy.readAllBytes());
      }
      try (var row = f.context.getContentResolver().query(uri,
          new String[]{MediaStore.Video.Media.IS_PENDING, MediaStore.Video.Media.RELATIVE_PATH}, null, null, null)) {
        assertTrue(row.moveToFirst()); assertEquals(0, row.getInt(0)); assertEquals("Movies/DinkVision/", row.getString(1));
      }
      f.exportGallery(id);
      Uri another = Uri.parse(f.item(id).getString("exportedUri")); f.copies.add(another);
      assertNotEquals(uri, another);
      assertTrue(LocalVideoExporter.readable(f.context.getContentResolver(), uri.toString()));
      assertArrayEquals(original, Files.readAllBytes(f.engine.localPlaybackFile(id).toPath()));
      assertEquals("failed", f.item(id).getString("status"));
    }
  }

  @Test public void privatePlaybackChecksOwnershipAndSupportsSeeking() throws Exception {
    try (Fixture f = new Fixture()) {
      String id = f.add(f.device, "failed"), foreign = f.add(UUID.randomUUID().toString(), "failed");
      var response = LocalVideoResponse.open(f.engine, id + ".mp4", "bytes=31-67");
      assertEquals(206, response.getStatusCode());
      assertEquals("bytes 31-67/2048",response.getResponseHeaders().get("Content-Range"));
      try (InputStream input = response.getData()) {
        assertEquals("WebView must apply its own Range offset once",31,input.skip(31));
        assertArrayEquals(Arrays.copyOfRange(Files.readAllBytes(f.engine.localPlaybackFile(id).toPath()),31,68), input.readNBytes(37));
      }
      try (InputStream tail=LocalVideoResponse.open(f.engine,id+".mp4","bytes=2000-").getData()) {
        assertEquals(2000,tail.skip(2000));assertEquals(48,tail.readAllBytes().length);
      }
      assertEquals(404, LocalVideoResponse.open(f.engine, foreign + ".mp4", null).getStatusCode());
      assertEquals(404, LocalVideoResponse.open(f.engine, "../vault.mp4", null).getStatusCode());
    }
  }

  @Test public void removedCopyPresenceAcknowledgementSurvivesStaleWorkersAndRestart() throws Exception {
    java.util.concurrent.atomic.AtomicInteger reports=new java.util.concurrent.atomic.AtomicInteger();
    boolean[] fail={true};
    Api.Connections transport=url->new java.net.HttpURLConnection(url){
      final ByteArrayOutputStream body=new ByteArrayOutputStream();
      public void connect(){}public void disconnect(){}public boolean usingProxy(){return false;}
      public OutputStream getOutputStream(){return body;}
      public Map<String,List<String>> getHeaderFields(){return Map.of();}
      public int getResponseCode() throws IOException {
        try{if("queue-report".equals(new JSONObject(body.toString("UTF-8")).optString("action"))){reports.incrementAndGet();return fail[0]?503:200;}}
        catch(Exception bad){throw new IOException(bad);}return 200;
      }
      public InputStream getInputStream(){return new ByteArrayInputStream("{\"ok\":true}".getBytes(java.nio.charset.StandardCharsets.UTF_8));}
    };
    try(Fixture f=new Fixture(transport)){
      String id=f.add(f.device,"local_only");
      f.exportGallery(id);
      Uri copy=Uri.parse(f.item(id).getString("exportedUri"));f.copies.add(copy);
      f.engine.removeLocalVideo(id);f.engine.exports.submit(()->{}).get(15,TimeUnit.SECONDS);
      JSONObject stale=f.item(id);
      assertThrows(Exception.class,f.engine::reportFilePresence);
      assertTrue("Failed delivery must remain durable",f.item(id).getBoolean("presenceReportPending"));
      fail[0]=false;f.engine.reportFilePresence();assertEquals(2,reports.get());
      assertFalse("Confirmed removal must stop refreshing Admin cleanup time",f.item(id).getBoolean("presenceReportPending"));
      var save=Engine.class.getDeclaredMethod("saveQueueItem",JSONObject.class);save.setAccessible(true);save.invoke(f.engine,stale);
      f.engine.reportFilePresence();assertEquals("A stale worker cannot requeue an acknowledged tombstone",2,reports.get());
      Engine reopened=new Engine(f.context,transport);reopened.heartbeat.shutdownNow();
      try{reopened.reportFilePresence();assertEquals("Acknowledgement survives process restart",2,reports.get());}
      finally{reopened.work.shutdownNow();reopened.uploads.shutdownNow();reopened.exports.shutdownNow();}
      assertTrue(LocalVideoExporter.verifiedCopy(f.context.getContentResolver(),copy.toString(),2048));
    }
  }

  @Test public void removingAnExportedAppCopyPreservesGalleryAndReportsItsIntent() throws Exception {
    org.junit.Assume.assumeTrue(android.os.Build.VERSION.SDK_INT>=29);
    try(Fixture f=new Fixture()){
      String id=f.add(f.device,"local_only");
      f.exportGallery(id);
      Uri copy=Uri.parse(f.item(id).getString("exportedUri"));f.copies.add(copy);
      byte[] expected=Files.readAllBytes(f.engine.localPlaybackFile(id).toPath());
      assertTrue(LocalVideoExporter.verifiedCopy(f.context.getContentResolver(),copy.toString(),expected.length));
      f.engine.removeLocalVideo(id);f.engine.exports.submit(()->{}).get(10,TimeUnit.SECONDS);
      assertEquals("",f.engine.localVideoError);assertFalse(new File(f.directory,id+".mp4").exists());
      try(InputStream in=f.context.getContentResolver().openInputStream(copy)){assertArrayEquals(expected,in.readAllBytes());}
      JSONObject item=f.item(id);assertFalse(item.getBoolean("localAvailable"));assertTrue(item.getBoolean("presenceReportPending"));
      assertTrue(item.getLong("localRemovedAt")>0);assertTrue(item.getString("lastError").startsWith("App copy removed by user."));
      assertTrue("An unreported export receipt must survive removing the private copy",item.getBoolean("exportReportPending"));
      assertEquals(0,new JSONObject(f.engine.snapshot()).getJSONArray("savedVideos").length());
    }
  }

  @Test public void manualRetryAfterEightFailuresStartsANewBudgetAndDoesNotDuplicate() throws Exception {
    try(Fixture f=new Fixture()){
      String id=f.add(f.device,"failed");
      f.engine.retryUpload(id);assertEquals("pending",f.item(id).getString("status"));
      assertEquals(0,f.item(id).getInt("retryCount"));assertEquals(0,f.item(id).getLong("nextRetryAt"));
      f.engine.retryUpload(id);assertEquals(1,f.engine.vault.array("upload-queue").length());
      JSONArray queue=f.engine.vault.array("upload-queue");queue.getJSONObject(0).put("status","retrying").put("retryCount",7);
      f.engine.vault.put("upload-queue",queue.toString());f.engine.retryUpload(id);
      assertEquals("pending",f.item(id).getString("status"));assertEquals(7,f.item(id).getInt("retryCount"));
      assertTrue(f.engine.localPlaybackFile(id).isFile());
    }
  }

  @Test public void anAcknowledgedCaptureReleaseIsNotConfusedWithAStaleServerSnapshot() throws Exception {
    try(Fixture f=new Fixture()){
      String id=f.add(f.device,"retrying");JSONArray queue=f.engine.vault.array("upload-queue");
      queue.getJSONObject(0).put("captureReleased",true);f.engine.vault.put("upload-queue",queue.toString());
      f.engine.server=new JSONObject().put("session",new JSONObject().put("id",id).put("status","finalizing"));
      assertTrue(new JSONObject(f.engine.snapshot()).getBoolean("previousCaptureReleased"));
      f.engine.busy=true;assertFalse(new JSONObject(f.engine.snapshot()).getBoolean("previousCaptureReleased"));
      f.engine.busy=false;f.engine.server.put("session",new JSONObject().put("id",UUID.randomUUID().toString()).put("status","recording"));
      assertFalse(new JSONObject(f.engine.snapshot()).getBoolean("previousCaptureReleased"));
    }
  }

  @Test public void removalRejectsUnexportedOrBusyFilesAndADeletedGalleryCopy() throws Exception {
    org.junit.Assume.assumeTrue(android.os.Build.VERSION.SDK_INT>=29);
    try(Fixture f=new Fixture()){
      String id=f.add(f.device,"failed");File source=f.engine.localPlaybackFile(id);
      f.engine.removeLocalVideo(id);f.engine.exports.submit(()->{}).get(10,TimeUnit.SECONDS);
      assertTrue(source.isFile());assertTrue(f.engine.localVideoError.contains("Save a verified"));
      f.exportGallery(id);
      Uri copy=Uri.parse(f.item(id).getString("exportedUri"));f.copies.add(copy);
      f.engine.busy=true;f.engine.removeLocalVideo(id);f.engine.exports.submit(()->{}).get(10,TimeUnit.SECONDS);
      assertTrue(source.isFile());f.engine.busy=false;
      f.context.getContentResolver().delete(copy,null,null);
      f.engine.removeLocalVideo(id);f.engine.exports.submit(()->{}).get(10,TimeUnit.SECONDS);
      assertTrue(source.isFile());assertTrue(f.engine.localVideoError.contains("Save a verified"));
      JSONArray pendingRemoval=f.engine.vault.array("upload-queue");pendingRemoval.getJSONObject(0).put("removalPending",true);
      f.engine.vault.put("upload-queue",pendingRemoval.toString());f.engine.finishPendingLocalRemovals();
      assertTrue(source.isFile());assertFalse(f.item(id).getBoolean("removalPending"));
      String foreign=f.add(UUID.randomUUID().toString(),"local_only");
      f.engine.removeLocalVideo(foreign);f.engine.exports.submit(()->{}).get(10,TimeUnit.SECONDS);
      assertTrue(new File(f.directory,foreign+".mp4").isFile());
    }
  }

  @Test public void sameSizeChangedExportCannotReplaceTheOnlyVerifiedOriginal() throws Exception {
    org.junit.Assume.assumeTrue(android.os.Build.VERSION.SDK_INT >= 29);
    try (Fixture f = new Fixture()) {
      String id = f.add(f.device, "local_only");
      File source = f.engine.localPlaybackFile(id);
      byte[] original = Files.readAllBytes(source.toPath());
      f.exportGallery(id);
      Uri copy = Uri.parse(f.item(id).getString("exportedUri"));
      f.copies.add(copy);
      byte[] damaged = original.clone();
      damaged[damaged.length / 2] ^= 1;
      try (OutputStream out = f.context.getContentResolver().openOutputStream(copy, "wt")) {
        assertNotNull(out);
        out.write(damaged);
      }
      assertTrue(LocalVideoExporter.verifiedCopy(f.context.getContentResolver(), copy.toString(), original.length));
      f.engine.removeLocalVideo(id);
      f.engine.exports.submit(() -> {}).get(10, TimeUnit.SECONDS);
      assertArrayEquals(original, Files.readAllBytes(source.toPath()));
      assertTrue(f.item(id).getBoolean("localAvailable"));
      assertFalse(f.item(id).optBoolean("removalPending"));
      assertTrue(f.engine.localVideoError.contains("Save a verified"));
    }
  }

  @Test public void interruptedRemovalCompletesItsJournalWithoutLosingTheExportReceipt() throws Exception {
    org.junit.Assume.assumeTrue(android.os.Build.VERSION.SDK_INT>=29);
    try(Fixture f=new Fixture()){
      String id=f.add(f.device,"local_only");
      f.exportGallery(id);
      f.copies.add(Uri.parse(f.item(id).getString("exportedUri")));
      JSONArray queue=f.engine.vault.array("upload-queue");queue.getJSONObject(0).put("removalPending",true);
      f.engine.vault.put("upload-queue",queue.toString());
      assertTrue(new File(f.directory,id+".mp4").delete()); // Crash after unlink, before journal completion.
      f.engine.finishPendingLocalRemovals();f.engine.reconcileMissingLocalFiles();
      assertEquals("local_only",f.item(id).getString("status"));assertFalse(f.item(id).getBoolean("localAvailable"));
      assertFalse(f.item(id).getBoolean("removalPending"));assertTrue(f.item(id).getLong("localRemovedAt")>0);
      assertTrue(f.item(id).getBoolean("exportReportPending"));
    }
  }

  @Test public void failedCopyRemovesOnlyItsIncompleteOutput() throws Exception {
    org.junit.Assume.assumeTrue(android.os.Build.VERSION.SDK_INT >= 29);
    try (Fixture f = new Fixture()) {
      String id = f.add(f.device, "failed");
      File source = f.engine.localPlaybackFile(id);
      byte[] original = Files.readAllBytes(source.toPath());
      AtomicReference<Uri> destination = new AtomicReference<>();
      assertThrows(Exception.class, () -> LocalVideoExporter.save(f.context, source, "dinkvision-copy-failure-test.mp4", null,
          percent -> { throw new IllegalStateException("Simulated full destination"); }, destination::set));
      assertNotNull(destination.get());
      assertFalse(LocalVideoExporter.readable(f.context.getContentResolver(), destination.get().toString()));
      assertArrayEquals(original, Files.readAllBytes(source.toPath()));
    }
  }

  @Test public void interruptedCopyCleanupNeverDeletesAPublishedCopy() throws Exception {
    org.junit.Assume.assumeTrue(android.os.Build.VERSION.SDK_INT >= 29);
    try (Fixture f = new Fixture()) {
      ContentValues values = new ContentValues();
      values.put(MediaStore.Video.Media.DISPLAY_NAME, "dinkvision-interrupted-test.mp4");
      values.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");
      values.put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/DinkVision");
      values.put(MediaStore.Video.Media.IS_PENDING, 1);
      Uri pending = f.context.getContentResolver().insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values);
      f.copies.add(pending);
      LocalVideoExporter.cleanupInterruptedGalleryCopy(f.context, pending.toString());
      assertFalse(LocalVideoExporter.readable(f.context.getContentResolver(), pending.toString()));
      String id = f.add(f.device, "failed");
      Uri published = LocalVideoExporter.save(f.context, f.engine.localPlaybackFile(id), "dinkvision-published-test.mp4", null, p -> {}, uri -> {});
      f.copies.add(published);
      LocalVideoExporter.cleanupInterruptedGalleryCopy(f.context, published.toString());
      assertTrue(LocalVideoExporter.readable(f.context.getContentResolver(), published.toString()));
    }
  }
}
