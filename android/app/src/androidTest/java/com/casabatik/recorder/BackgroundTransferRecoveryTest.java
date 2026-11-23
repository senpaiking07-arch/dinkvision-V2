package com.casabatik.recorder;

import static org.junit.Assert.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.*;
import org.json.*;
import org.junit.Test;

public class BackgroundTransferRecoveryTest {
  private Context isolatedContext() {
    Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
    String namespace = "transfer-pause-" + UUID.randomUUID();
    File root = new File(base.getCacheDir(), namespace);
    assertTrue(root.mkdirs());
    return new ContextWrapper(base) {
      public Context getApplicationContext() { return this; }
      public File getFilesDir() { return root; }
      public File getCacheDir() { return root; }
      public SharedPreferences getSharedPreferences(String name, int mode) {
        return base.getSharedPreferences(namespace + name, mode);
      }
    };
  }

  @Test public void pauseSurvivesRestartAndOldWorkerCannotResumeAfterForegroundEntry() throws Exception {
    Context context = isolatedContext();
    BackgroundTransfers control = new BackgroundTransfers(context);
    try (var old = control.begin()) {
      control.pause();
      assertTrue(new BackgroundTransfers(context).isPaused());
      control.foregroundEntered();
      assertTrue("Old work must stay cancelled after return", old.cancelled());
    }
    assertFalse(Thread.currentThread().isInterrupted());
    try (var fresh = control.begin()) { fresh.check(); }
    assertFalse(new BackgroundTransfers(context).isPaused());
  }

  @Test public void uploadPauseKeepsJobBytesRetryBudgetAndEnrollmentAcrossRestart() throws Exception {
    Context context = isolatedContext();
    Engine engine = new Engine(context);
    engine.heartbeat.shutdownNow();
    File directory = new File(context.getFilesDir(), "recordings");
    assertTrue(directory.mkdirs());
    String sid = UUID.randomUUID().toString();
    File file = new File(directory, sid + ".mp4");
    try (var out = new FileOutputStream(file)) { out.write(new byte[2048]); }
    JSONObject job = new JSONObject().put("id", sid).put("status", "uploading")
        .put("retryCount", 7).put("progress", 41).put("branded", true).put("localAvailable", true);
    engine.vault.put("device-id", "fixture-enrollment");
    engine.vault.put("upload-queue", new JSONArray().put(job).toString());
    engine.busy = true; engine.stop = false;
    engine.pauseBackgroundTransfers();
    assertFalse(engine.stop);
    assertTrue(engine.busy);
    Engine restarted = new Engine(context);
    restarted.heartbeat.shutdownNow();
    try {
      JSONObject restored = restarted.vault.array("upload-queue").getJSONObject(0);
      assertEquals("pending", restored.getString("status"));
      assertEquals(7, restored.getInt("retryCount"));
      assertEquals(41, restored.getInt("progress"));
      assertTrue(restored.getBoolean("branded"));
      assertEquals(2048, file.length());
      assertEquals("fixture-enrollment", restarted.vault.get("device-id"));
      assertTrue(restarted.backgroundTransfers.isPaused());
    } finally {
      engine.work.shutdownNow(); engine.uploads.shutdownNow(); engine.exports.shutdownNow();
      restarted.work.shutdownNow(); restarted.uploads.shutdownNow(); restarted.exports.shutdownNow();
      file.delete(); directory.delete();
    }
  }

  @Test public void confirmedFinishRemainsSuccessfulWhenPauseArrivesDuringItsResponse() throws Exception {
    BackgroundTransfers control = new BackgroundTransfers(isolatedContext());
    int[] finished = {0};
    try (var ticket = control.begin()) {
      UploadTransfer.send(1024, ticket.guard(new UploadTransfer.Transport() {
        public JSONObject action(String action) throws Exception {
          if (action.equals("upload")) return new JSONObject().put("ready", true);
          if (action.equals("finish")) {
            finished[0]++;
            control.pause();
            return new JSONObject().put("ready", true);
          }
          throw new AssertionError(action);
        }
        public JSONObject chunk(long offset, int length) { throw new AssertionError("Already uploaded"); }
      }), percent -> {});
    }
    assertEquals(1, finished[0]);
  }

  @Test public void pauseStopsFurtherChunksAndResumesAtServerConfirmedOffset() throws Exception {
    BackgroundTransfers control = new BackgroundTransfers(isolatedContext());
    long[] accepted = {0};
    int[] chunks = {0};
    UploadTransfer.Transport transport = new UploadTransfer.Transport() {
      public JSONObject action(String action) throws Exception {
        if (action.equals("upload")) return new JSONObject().put("ready", false);
        if (action.equals("upload-status")) return accepted[0] == 8 * 1024 * 1024
            ? new JSONObject().put("uploaded", true) : new JSONObject().put("offset", accepted[0]);
        return new JSONObject().put("ready", true);
      }
      public JSONObject chunk(long offset, int length) throws Exception {
        assertEquals(accepted[0], offset);
        accepted[0] += length;
        if (++chunks[0] == 1) control.pause();
        return new JSONObject().put("accepted", true);
      }
      public List<UploadTransfer.PartGrant> grants(long offset, int count, int size, long total) {
        return List.of(new UploadTransfer.PartGrant((int) (offset / size) + 1, offset, size, ""));
      }
    };
    try (var first = control.begin()) {
      try { UploadTransfer.send(8 * 1024 * 1024, first.guard(transport), percent -> {}); fail(); }
      catch (InterruptedIOException expected) { }
    }
    assertEquals(1, chunks[0]);
    control.foregroundEntered();
    try (var retry = control.begin()) {
      UploadTransfer.send(8 * 1024 * 1024, retry.guard(transport), percent -> {});
    }
    assertEquals(2, chunks[0]);
  }

  @Test public void pauseCancelsWaitingMultipartWorkerWithoutFinishing() throws Exception {
    BackgroundTransfers control = new BackgroundTransfers(isolatedContext());
    CountDownLatch partsStarted = new CountDownLatch(2);
    CountDownLatch releaseParts = new CountDownLatch(1);
    ExecutorService worker = Executors.newSingleThreadExecutor();
    int partSize = 8 * 1024 * 1024;
    UploadTransfer.Transport transport = new UploadTransfer.Transport() {
      public JSONObject action(String action) throws Exception {
        if ("upload".equals(action)) return new JSONObject().put("upload", new JSONObject()
            .put("protocol", "r2-multipart-v1").put("partSize", partSize).put("bytes", 2L * partSize));
        if ("upload-status".equals(action)) return new JSONObject().put("offset", 0);
        throw new AssertionError("Cancellation must not finalize the upload: " + action);
      }
      public List<UploadTransfer.PartGrant> grants(long offset, int count, int size, long total) {
        return List.of(new UploadTransfer.PartGrant(1, 0, partSize, ""),
            new UploadTransfer.PartGrant(2, partSize, partSize, ""));
      }
      public JSONObject chunk(long offset, int length) throws Exception {
        partsStarted.countDown();
        if (!releaseParts.await(10, TimeUnit.SECONDS)) throw new AssertionError("Part worker was not released");
        return new JSONObject().put("accepted", true);
      }
    };
    try {
      Future<?> result = worker.submit(() -> {
        try (var ticket = control.begin()) {
          assertThrows(InterruptedIOException.class,
              () -> UploadTransfer.send(2L * partSize, ticket.guard(transport), percent -> {}));
        }
        return null;
      });
      assertTrue(partsStarted.await(5, TimeUnit.SECONDS));
      control.pause();
      result.get(8, TimeUnit.SECONDS);
    } finally {
      releaseParts.countDown();
      worker.shutdownNow();
    }
  }

  @Test public void serviceTimeoutReleasesTransfersAndPreservesCameraProtection() throws Exception {
    var instrumentation = InstrumentationRegistry.getInstrumentation();
    Context context = instrumentation.getTargetContext();
    instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), android.Manifest.permission.CAMERA);
    instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), android.Manifest.permission.RECORD_AUDIO);
    Engine engine = Engine.get(context);
    engine.heartbeat.shutdownNow();
    try (var activity = androidx.test.core.app.ActivityScenario.launch(MainActivity.class)) {
      engine.busy = true; engine.stop = false;
      activity.onActivity(a -> {
        engine.startService(true, false);
        engine.startService(false, true);
      });
      long deadline = System.nanoTime() + 5_000_000_000L;
      while ((!TransferService.isReady() || !RecorderService.holdsCpuWakeLock()) && System.nanoTime() < deadline)
        Thread.sleep(25);
      assertTrue(TransferService.isReady());
      var running = TransferService.class.getDeclaredField("running");
      running.setAccessible(true);
      TransferService service = (TransferService) running.get(null);
      instrumentation.runOnMainSync(() -> service.onTimeout(1, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC));
      instrumentation.waitForIdleSync();
      assertFalse(TransferService.isReady());
      assertTrue(engine.backgroundTransfers.isPaused());
      assertTrue(RecorderService.holdsCpuWakeLock());
      assertTrue(engine.busy);
      assertFalse(engine.stop);
      activity.onActivity(a -> engine.resumeBackgroundTransfers());
      assertFalse(engine.backgroundTransfers.isPaused());
    } finally {
      engine.busy = false;
      engine.backgroundTransfers.foregroundEntered();
      context.stopService(new Intent(context, RecorderService.class));
      context.stopService(new Intent(context, TransferService.class));
    }
  }
}
