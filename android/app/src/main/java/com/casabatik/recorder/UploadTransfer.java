package com.casabatik.recorder;

import org.json.JSONObject;

/** Sends bytes through its transport and resumes only from Drive-confirmed offsets. */
final class UploadTransfer {
  static final class WaitingForTurn extends Exception {
    WaitingForTurn() { super("Waiting for the upload turn."); }
  }

  static final class CancelledException extends Exception {
    CancelledException() {
      super(
          "Upload cancelled by venue staff. The video remains saved on this device. Choose Recover upload when ready.");
    }
  }

  interface Transport {
    JSONObject action(String action) throws Exception;

    JSONObject chunk(long offset, int length) throws Exception;
  }

  interface Progress {
    void update(long percent);
    default void acknowledged(long bytes, long total) { update(bytes * 100 / total); }
    default void verifying(long bytes) {}
  }

  interface QueueProgress {
    void update(JSONObject queue);
  }

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
        throw new Exception(
            "Upload paused after a connection problem. Automatic retry is scheduled.");
      queueProgress.update(queue);
      if (yieldWhenQueued) throw new WaitingForTurn();
      Thread.sleep(2000);
      prepared = transport.action("upload");
    }
    return prepared;
  }

  static void send(
      long bytes, Transport transport, Progress progress, QueueProgress queueProgress)
      throws Exception {
    send(bytes, transport, progress, queueProgress, false);
  }

  static void send(
      long bytes,
      Transport transport,
      Progress progress,
      QueueProgress queueProgress,
      boolean retryCancelled)
      throws Exception {
    send(bytes, transport, progress, queueProgress, retryCancelled, false);
  }

  static void send(
      long bytes, Transport transport, Progress progress, QueueProgress queueProgress,
      boolean retryCancelled, boolean yieldWhenQueued) throws Exception {
    JSONObject prepared =
        waitForTurn(
            transport.action(retryCancelled ? "retry-upload" : "upload"),
            transport,
            queueProgress, yieldWhenQueued);
    int restarts = 0, stalled = 0;
    long previous = -1;
    while (!prepared.optBoolean("ready")) {
      JSONObject status = transport.action("upload-status");
      if (status.optBoolean("uploaded")) break;
      if (status.optBoolean("expired")) {
        if (++restarts > 2) throw new Exception("Upload expired. Retry the saved video.");
        prepared =
            waitForTurn(transport.action("restart-upload"), transport, queueProgress, yieldWhenQueued);
        previous = -1;
        continue;
      }
      long offset = status.getLong("offset");
      if (offset < 0 || offset >= bytes) throw new Exception("Invalid upload offset.");
      if (offset == previous) {
        if (++stalled > 2) throw new Exception("Upload stalled. Retry the saved video.");
      } else stalled = 0;
      previous = offset;
      progress.acknowledged(offset, bytes);
      JSONObject result = transport.chunk(offset, (int) Math.min(4 * 1024 * 1024, bytes - offset));
      if (result.optBoolean("expired")) {
        if (++restarts > 2) throw new Exception("Upload expired. Retry the saved video.");
        prepared =
            waitForTurn(transport.action("restart-upload"), transport, queueProgress, yieldWhenQueued);
        previous = -1;
      } else if (!result.optBoolean("accepted")) {
        throw new Exception("Upload not accepted. Retry the saved video.");
      }
    }
    progress.verifying(bytes);
    if (!transport.action("finish").optBoolean("ready"))
      throw new Exception("Waiting for upload confirmation. Retry the saved video.");
    progress.update(100);
  }
}
