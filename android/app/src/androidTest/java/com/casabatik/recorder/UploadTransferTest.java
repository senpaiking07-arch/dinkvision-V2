package com.casabatik.recorder;

import static org.junit.Assert.*;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class UploadTransferTest {
  @Test public void aQueuedVideoReturnsTheWorkerWithoutSendingBytesOrPolling() throws Exception {
    var calls = new java.util.ArrayList<String>();
    var waits = new java.util.concurrent.atomic.AtomicInteger();
    UploadTransfer.Transport transport = new UploadTransfer.Transport() {
      public JSONObject action(String action) throws Exception {
        calls.add(action);
        return new JSONObject().put("queued", true)
            .put("queue", new JSONObject().put("state", "pending"));
      }
      public JSONObject chunk(long offset, int length) {
        throw new AssertionError("A waiting video must not transfer data");
      }
    };
    assertThrows(UploadTransfer.WaitingForTurn.class,
        () -> UploadTransfer.send(1000, transport, p -> fail("Waiting is not transfer progress"),
            q -> waits.incrementAndGet(), false, true));
    assertEquals(java.util.List.of("upload"), calls);
    assertEquals(1, waits.get());
  }
  static class Backend implements UploadTransfer.Transport {
    long offset = 0, bytes = 5 * 1024 * 1024;
    int chunks = 0, restarts = 0;
    boolean expire = false, loseResponse = false, confirm = true;

    public JSONObject action(String action) throws Exception {
      if (action.equals("upload")) return new JSONObject().put("ready", false);
      if (action.equals("restart-upload")) {
        restarts++;
        offset = 0;
        return new JSONObject().put("ready", false);
      }
      if (action.equals("finish")) return new JSONObject().put("ready", confirm && offset == bytes);
      return offset == bytes
          ? new JSONObject().put("uploaded", true)
          : new JSONObject().put("offset", offset);
    }

    public JSONObject chunk(long start, int length) throws Exception {
      assertEquals(offset, start);
      assertTrue(length > 0 && length <= 4 * 1024 * 1024);
      chunks++;
      if (expire) {
        expire = false;
        return new JSONObject().put("expired", true);
      }
      offset += length;
      if (loseResponse) {
        loseResponse = false;
        throw new java.io.IOException("Connection interrupted");
      }
      return new JSONObject().put("accepted", true).put("complete", offset == bytes);
    }
  }

  @Test
  public void currentResponseWithoutUriUploadsAndConfirms() throws Exception {
    Backend backend = new Backend();
    long[] progress = {-1};
    UploadTransfer.send(backend.bytes, backend, value -> progress[0] = value);
    assertEquals(2, backend.chunks);
    assertEquals(100, progress[0]);
  }

  @Test
  public void queuedUploadWaitsForTheFirstDeviceAndReportsItsProgress() throws Exception {
    Backend backend =
        new Backend() {
          int uploadCalls = 0;

          public JSONObject action(String action) throws Exception {
            if (action.equals("upload") && uploadCalls++ == 0)
              return new JSONObject()
                  .put("ready", false)
                  .put("queued", true)
                  .put(
                      "queue",
                      new JSONObject()
                          .put("activeDevice", "Tablet 1")
                          .put("position", 2)
                          .put("total", 2)
                          .put("percent", 45));
            return super.action(action);
          }
        };
    int[] queueProgress = {-1};
    UploadTransfer.send(
        backend.bytes,
        backend,
        value -> {},
        queue -> queueProgress[0] = queue.optInt("percent"));
    assertEquals(45, queueProgress[0]);
    assertEquals(backend.bytes, backend.offset);
  }

  @Test
  public void cancelledUploadStopsUntilManualRecoveryRequeuesIt() throws Exception {
    boolean[] retried = {false};
    Backend backend =
        new Backend() {
          public JSONObject action(String action) throws Exception {
            if (action.equals("retry-upload")) {
              retried[0] = true;
              return new JSONObject().put("ready", false);
            }
            if (action.equals("upload") && !retried[0])
              return new JSONObject()
                  .put("ready", false)
                  .put("queued", true)
                  .put("queue", new JSONObject().put("state", "cancelled"));
            return super.action(action);
          }
        };
    try {
      UploadTransfer.send(backend.bytes, backend, value -> {});
      fail();
    } catch (UploadTransfer.CancelledException expected) {
      assertTrue(expected.getMessage().contains("remains saved"));
    }
    assertEquals(0, backend.chunks);

    UploadTransfer.send(backend.bytes, backend, value -> {}, queue -> {}, true);
    assertTrue(retried[0]);
    assertEquals(backend.bytes, backend.offset);
  }

  @Test
  public void recoveryResumesAtAcknowledgedOffsetAfterLostResponse() throws Exception {
    Backend backend = new Backend();
    backend.loseResponse = true;
    try {
      UploadTransfer.send(backend.bytes, backend, value -> {});
      fail();
    } catch (java.io.IOException expected) {
    }
    assertEquals(4 * 1024 * 1024, backend.offset);
    UploadTransfer.send(backend.bytes, backend, value -> {});
    assertEquals(2, backend.chunks);
    assertEquals(backend.bytes, backend.offset);
  }

  @Test
  public void expiredSessionRestartsAndMissingConfirmationFails() throws Exception {
    Backend backend = new Backend();
    backend.expire = true;
    backend.confirm = false;
    var progress = new java.util.ArrayList<String>();
    UploadTransfer.Progress observer = new UploadTransfer.Progress() {
      public void update(long percent) { progress.add("percent:" + percent); }
      public void acknowledged(long bytes, long total) { progress.add("acknowledged:" + bytes); }
      public void verifying(long bytes) { progress.add("verifying:" + bytes); }
    };
    try {
      UploadTransfer.send(backend.bytes, backend, observer);
      fail();
    } catch (Exception expected) {
      assertTrue(expected.getMessage().contains("confirmation"));
    }
    assertEquals(java.util.List.of("acknowledged:0", "acknowledged:0", "acknowledged:4194304",
        "verifying:" + backend.bytes), progress);
    assertEquals(1, backend.restarts);
    backend.confirm = true;
    progress.clear();
    UploadTransfer.send(backend.bytes, backend, observer);
    assertEquals(java.util.List.of("verifying:" + backend.bytes, "percent:100"), progress);
    assertEquals(3, backend.chunks);
  }
}
