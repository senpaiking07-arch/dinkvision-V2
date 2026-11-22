package com.casabatik.recorder;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/** Sends bytes through its transport and resumes only from storage-confirmed offsets. */
final class UploadTransfer {
  static final int DEFAULT_PARALLELISM = 4;
  static final int MAX_PARALLELISM = 4;
  static final int BATCH_SIZE = 4;

  static final class WaitingForTurn extends Exception {
    WaitingForTurn() { super("Waiting for the upload turn."); }
  }

  static final class CancelledException extends Exception {
    CancelledException() {
      super(
          "Upload cancelled by venue staff. The video remains saved on this device. Choose Recover upload when ready.");
    }
  }

  static final class PartGrant {
    final int partNumber;
    final long offset;
    final int length;
    final String url;
    PartGrant(int partNumber, long offset, int length, String url) {
      this.partNumber = partNumber; this.offset = offset; this.length = length; this.url = url;
    }
  }

  interface Transport {
    JSONObject action(String action) throws Exception;
    JSONObject chunk(long offset, int length) throws Exception;
    default List<PartGrant> grants(long offset, int count, int partSize, long totalBytes) throws Exception {
      List<PartGrant> out = new ArrayList<>();
      for (int i = 0; i < count; i++) {
        long off = offset + (long) i * partSize;
        if (off >= totalBytes) break;
        int len = (int) Math.min(partSize, totalBytes - off);
        JSONObject r = chunk(off, len);
        if (r.optBoolean("expired")) {
          PartGrant expired = new PartGrant(-1, off, len, "");
          out.clear(); out.add(expired); return out;
        }
        String url = r.optString("url", "");
        int pn = r.optInt("partNumber", (int) (off / partSize) + 1);
        out.add(new PartGrant(pn, off, len, url));
      }
      return out;
    }
    default boolean putPart(PartGrant grant) throws Exception {
      JSONObject r = chunk(grant.offset, grant.length);
      if (r.optBoolean("expired")) throw new ExpiredPartException();
      return r.optBoolean("accepted") || r.optString("url", "").isEmpty();
    }
  }

  static final class ExpiredPartException extends Exception {}

  interface Progress {
    void update(long percent);
    default void acknowledged(long bytes, long total) { update(bytes * 100 / total); }
    default void verifying(long bytes) {}
  }

  interface QueueProgress { void update(JSONObject queue); }

  static void send(long bytes, Transport transport, Progress progress) throws Exception {
    send(bytes, transport, progress, queue -> {});
  }

  private static JSONObject waitForTurn(
      JSONObject prepared, Transport transport, QueueProgress queueProgress, boolean yieldWhenQueued)
      throws Exception {
    while (prepared.optBoolean("queued")) {
      JSONObject queue = prepared.optJSONObject("queue");
      if (queue == null) throw new Exception("Upload queue status is unavailable.");
      if ("cancelled".equals(queue.optString("state"))) throw new CancelledException();
      if ("failed".equals(queue.optString("state")))
        throw new Exception("Upload paused after a connection problem. Automatic retry is scheduled.");
      queueProgress.update(queue);
      if (yieldWhenQueued) throw new WaitingForTurn();
      Thread.sleep(2000);
      prepared = transport.action("upload");
    }
    return prepared;
  }

  static void send(long bytes, Transport transport, Progress progress, QueueProgress queueProgress) throws Exception {
    send(bytes, transport, progress, queueProgress, false);
  }

  static void send(long bytes, Transport transport, Progress progress, QueueProgress queueProgress, boolean retryCancelled)
      throws Exception {
    send(bytes, transport, progress, queueProgress, retryCancelled, false);
  }

  static void send(
      long bytes, Transport transport, Progress progress, QueueProgress queueProgress,
      boolean retryCancelled, boolean yieldWhenQueued) throws Exception {
    JSONObject prepared = waitForTurn(transport.action(retryCancelled ? "retry-upload" : "upload"),
        transport, queueProgress, yieldWhenQueued);
    int restarts = 0, stalled = 0;
    long previous = -1;
    int parallelism = DEFAULT_PARALLELISM;
    while (!prepared.optBoolean("ready")) {
      JSONObject status = transport.action("upload-status");
      if (status.optBoolean("uploaded")) break;
      if (status.optBoolean("expired")) {
        if (++restarts > 2) throw new Exception("Upload expired. Retry the saved video.");
        prepared = waitForTurn(transport.action("restart-upload"), transport, queueProgress, yieldWhenQueued);
        previous = -1; stalled = 0; continue;
      }
      long offset = status.getLong("offset");
      if (offset < 0 || offset >= bytes) throw new Exception("Invalid upload offset.");
      if (offset == previous) { if (++stalled > 2) throw new Exception("Upload stalled. Retry the saved video."); }
      else stalled = 0;
      previous = offset;
      progress.acknowledged(offset, bytes);
      JSONObject upload = prepared.optJSONObject("upload");
      int partSize = upload == null ? 4 * 1024 * 1024 : upload.optInt("partSize");
      if (upload != null) {
        String protocol = upload.optString("protocol");
        boolean legacyDrive = "drive-resumable".equals(protocol) || protocol.isEmpty();
        boolean r2 = "r2-multipart-v1".equals(protocol);
        if ((!legacyDrive && !r2) || upload.optLong("bytes") != bytes)
          throw new Exception("Invalid storage upload contract. The local video is retained.");
        if (r2 && (partSize < 8 * 1024 * 1024 || partSize > 32 * 1024 * 1024 || (partSize & (partSize - 1)) != 0))
          throw new Exception("Invalid storage upload contract. The local video is retained.");
        parallelism = r2 ? Math.min(MAX_PARALLELISM, Math.max(1, upload.optInt("parallelism", DEFAULT_PARALLELISM))) : 1;
      }
      int remainingParts = (int) ((bytes - offset + partSize - 1) / partSize);
      int batch = Math.max(1, Math.min(parallelism, Math.min(BATCH_SIZE, remainingParts)));
      List<PartGrant> grants = transport.grants(offset, batch, partSize, bytes);
      if (grants.isEmpty()) {
        JSONObject s = transport.action("upload-status");
        if (s.optBoolean("uploaded")) break;
        if (s.optBoolean("expired")) {
          if (++restarts > 2) throw new Exception("Upload expired. Retry the saved video.");
          prepared = waitForTurn(transport.action("restart-upload"), transport, queueProgress, yieldWhenQueued);
          previous = -1; continue;
        }
        throw new Exception("Upload not accepted. Retry the saved video.");
      }
      if (grants.size() == 1 && grants.get(0).partNumber == -1) {
        if (++restarts > 2) throw new Exception("Upload expired. Retry the saved video.");
        prepared = waitForTurn(transport.action("restart-upload"), transport, queueProgress, yieldWhenQueued);
        previous = -1; continue;
      }
      boolean expired = uploadParts(transport, grants, parallelism);
      if (expired) {
        if (++restarts > 2) throw new Exception("Upload expired. Retry the saved video.");
        prepared = waitForTurn(transport.action("restart-upload"), transport, queueProgress, yieldWhenQueued);
        previous = -1;
      }
    }
    progress.verifying(bytes);
    if (!transport.action("finish").optBoolean("ready"))
      throw new Exception("Waiting for upload confirmation. Retry the saved video.");
    progress.update(100);
  }

  private static boolean uploadParts(Transport transport, List<PartGrant> grants, int parallelism) throws Exception {
    if (grants.size() == 1) return putWithRetry(transport, grants.get(0));
    ExecutorService exec = Executors.newFixedThreadPool(Math.min(parallelism, grants.size()));
    try {
      List<Future<Boolean>> futures = new ArrayList<>();
      for (PartGrant grant : grants) futures.add(exec.submit((Callable<Boolean>) () -> putWithRetry(transport, grant)));
      boolean expired = false;
      Exception first = null;
      for (Future<Boolean> f : futures) {
        try { expired |= f.get(); }
        catch (Exception e) {
          Throwable c = e.getCause() != null ? e.getCause() : e;
          if (c instanceof ExpiredPartException) expired = true;
          else if (first == null) first = c instanceof Exception ? (Exception) c : new Exception(c.getMessage(), c);
        }
      }
      if (first != null) throw first;
      return expired;
    } finally {
      exec.shutdownNow();
      try { exec.awaitTermination(5, TimeUnit.SECONDS); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
    }
  }

  private static boolean putWithRetry(Transport transport, PartGrant grant) throws Exception {
    int attempts = 0;
    long backoff = 1000;
    while (true) {
      try {
        transport.putPart(grant);
        return false;
      } catch (ExpiredPartException e) {
        return true;
      } catch (Exception e) {
        attempts++;
        if (Thread.currentThread().isInterrupted()) throw e;
        if (attempts >= 4) throw e;
        Thread.sleep(backoff + (long) (Math.random() * 250));
        backoff = Math.min(backoff * 2, 8000);
      }
    }
  }
}
