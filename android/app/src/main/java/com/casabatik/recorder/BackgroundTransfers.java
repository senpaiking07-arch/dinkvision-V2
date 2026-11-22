package com.casabatik.recorder;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.InterruptedIOException;
import java.util.HashSet;
import java.util.Set;

/** A system pause survives process death; only foreground entry permits another attempt. */
final class BackgroundTransfers {
  static final String PAUSED = "Android paused background work. Open DinkVision to resume. Your video is in Saved videos.";
  private final SharedPreferences preferences;
  private final Set<Ticket> workers = new HashSet<>();
  private boolean paused;
  private long generation;

  BackgroundTransfers(Context context) {
    preferences = context.getSharedPreferences("background-transfers", Context.MODE_PRIVATE);
    paused = preferences.getBoolean("paused", false);
  }

  synchronized boolean isPaused() { return paused; }

  synchronized void pause() {
    paused = true;
    generation++;
    preferences.edit().putBoolean("paused", true).apply();
    for (Ticket worker : workers) worker.thread.interrupt();
  }

  synchronized void foregroundEntered() {
    paused = false;
    preferences.edit().putBoolean("paused", false).apply();
  }

  synchronized Ticket begin() throws InterruptedIOException {
    if (paused) throw new InterruptedIOException(PAUSED);
    Ticket ticket = new Ticket(generation);
    workers.add(ticket);
    return ticket;
  }

  final class Ticket implements AutoCloseable {
    private final long startedGeneration;
    private final Thread thread = Thread.currentThread();
    private Ticket(long value) { startedGeneration = value; }

    boolean cancelled() {
      synchronized (BackgroundTransfers.this) {
        return paused || startedGeneration != generation || thread.isInterrupted();
      }
    }

    void check() throws InterruptedIOException {
      if (cancelled()) throw new InterruptedIOException(PAUSED);
    }

    UploadTransfer.Transport guard(UploadTransfer.Transport transport) {
      return new UploadTransfer.Transport() {
        public org.json.JSONObject action(String action) throws Exception {
          check();
          // Preserve authoritative completion even if the pause arrives during this request.
          return transport.action(action);
        }
        public org.json.JSONObject chunk(long offset, int length) throws Exception {
          check();
          return transport.chunk(offset, length);
        }
        public java.util.List<UploadTransfer.PartGrant> grants(long offset, int count, int partSize, long totalBytes) throws Exception {
          check();
          return transport.grants(offset, count, partSize, totalBytes);
        }
        public boolean putPart(UploadTransfer.PartGrant grant) throws Exception {
          check();
          return transport.putPart(grant);
        }
      };
    }

    @Override public void close() {
      synchronized (BackgroundTransfers.this) { workers.remove(this); }
      Thread.interrupted(); // The single-thread executor can run a later foreground attempt.
    }
  }
}
