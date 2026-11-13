package com.casabatik.recorder;

import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

/** Bounded, app-private diagnostic outbox. No addresses, credentials, URLs or exception text. */
final class RecorderDiagnostics {
  static final int MAX_EVENTS = 256;
  private static final java.time.format.DateTimeFormatter TIMESTAMP =
      new java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter();
  private final AtomicFile file;
  private JSONArray events = new JSONArray();
  private final ExecutorService writer = new ThreadPoolExecutor(0, 1, 1, TimeUnit.SECONDS,
      new ArrayBlockingQueue<>(64), new ThreadPoolExecutor.DiscardPolicy());
  private final ExecutorService reporter = new ThreadPoolExecutor(0, 1, 1, TimeUnit.SECONDS,
      new ArrayBlockingQueue<>(1), new ThreadPoolExecutor.AbortPolicy());
  private final java.util.concurrent.atomic.AtomicBoolean sending = new java.util.concurrent.atomic.AtomicBoolean();
  private volatile long nextSendAt;
  private int failures;

  RecorderDiagnostics(File directory) {
    file = new AtomicFile(new File(directory, "recorder-diagnostics.json"));
    try {
      if (file.getBaseFile().length() <= 262144) {
        JSONArray saved = new JSONArray(new String(file.readFully(), StandardCharsets.UTF_8));
        for (int i = Math.max(0, saved.length()-MAX_EVENTS); i<saved.length(); i++) events.put(saved.getJSONObject(i));
      }
    } catch (Exception ignored) { /* Diagnostics cannot prevent camera startup. */ }
  }

  Trace begin(String device, String operation, String session, int queueCount, int retries, long bytes) {
    return new Trace(device, operation, session, queueCount, retries, bytes);
  }

  Trace beginCapture(String device, int queueCount, long bridgeReceivedNanos, int webDelayMs) {
    return new Trace(device, "capture", "", queueCount, 0, 0, bridgeReceivedNanos,
        Math.max(0, Math.min(5_000, webDelayMs)));
  }

  enum ActionSource {
    PLAYER("player"), NOTIFICATION("notification"), ADMIN("admin");
    final String value;
    ActionSource(String value) { this.value = value; }
  }

  final class Trace {
    private final String device, operation, attempt = UUID.randomUUID().toString();
    private String session, stage = "work_queue";
    private final long started;
    private long changed;
    private final int queueCount, retries;
    private final long bytes;
    private boolean finished;
    private long acknowledged = -1, transferBaseline = -1, retryDelay = -1;
    private int httpStatus;
    private int repeatedStarts;
    private final EnumMap<ActionSource,Integer> repeatedStops = new EnumMap<>(ActionSource.class);
    private boolean stopRecorded;

    Trace(String device, String operation, String session, int queueCount, int retries, long bytes) {
      this(device, operation, session, queueCount, retries, bytes, System.nanoTime(), -1);
    }

    Trace(String device, String operation, String session, int queueCount, int retries, long bytes,
        long bridgeReceivedNanos, int webDelayMs) {
      this.device=device; this.operation=operation; this.session=session;
      this.queueCount=queueCount; this.retries=retries; this.bytes=bytes;
      started = bridgeReceivedNanos - TimeUnit.MILLISECONDS.toNanos(Math.max(0, webDelayMs));
      changed = bridgeReceivedNanos;
      if (webDelayMs >= 0) action("start_tap", ActionSource.PLAYER, 0, started);
    }

    synchronized void accepted() {
      long now = System.nanoTime();
      action("start_accepted", ActionSource.PLAYER, 0, now);
      changed = now;
    }

    synchronized void repeatedStart() {
      if (!finished) repeatedStarts = Math.min(1000, repeatedStarts + 1);
    }

    synchronized void stopRequested(ActionSource source) {
      if (finished || stopRecorded) return;
      stopRecorded = true;
      action("stop_requested", source, 0, System.nanoTime());
    }

    synchronized void repeatedStop(ActionSource source) {
      if (!finished) repeatedStops.merge(source, 1, (a, b) -> Math.min(1000, a + b));
    }

    synchronized void session(String value) { session=value; }
    synchronized void stage(String next) {
      if (finished || stage.equals(next)) return;
      emit("ok","none"); stage=next;
    }
    synchronized void finish(Exception failure) {
      if (finished) return;
      long now = System.nanoTime();
      if (repeatedStarts > 0) action("start_repeated", ActionSource.PLAYER, repeatedStarts, now);
      repeatedStops.forEach((source, count) -> action("stop_repeated", source, count, now));
      if (failure instanceof Api.RequestFailure) httpStatus = ((Api.RequestFailure) failure).httpStatus;
      emit(failure==null?"ok":"failed",failure==null?"none":code(failure));
      if (failure==null) { stage="complete"; emit("ok","none"); }
      finished=true;
    }
    synchronized void pausedBySystem() {
      if (finished) return;
      emit("waiting", "none");
      finished = true;
    }
    synchronized void waitingForUploadTurn() {
      if (finished) return;
      stage("queue_wait");
      emit("waiting", "none");
      finished = true;
    }
    synchronized void acknowledged(long offset) {
      if (transferBaseline < 0 || offset < acknowledged) transferBaseline = offset;
      acknowledged = offset;
    }
    synchronized void retryDelay(long delay) { retryDelay = delay; }
    private JSONObject event(String name, String result, String code, long now, long durationMs) throws JSONException {
      UUID.fromString(device);
      return new JSONObject().put("device_id",device)
          .put("event_id",UUID.randomUUID().toString()).put("attempt_id",attempt)
          .put("session_id",session.isEmpty()?JSONObject.NULL:session)
          .put("operation",operation).put("stage",name)
          .put("result",name.equals("queue_wait")&&result.equals("ok")?"waiting":result)
          .put("code",code).put("elapsed_ms",boundedMillis(now-started)).put("duration_ms",durationMs)
          .put("occurred_at",TIMESTAMP.format(Instant.now().minusNanos(Math.max(0, System.nanoTime() - now))))
          .put("queue_count",Math.min(10000,Math.max(0,queueCount))).put("bytes",Math.min(1_000_000_000_000L,Math.max(0,bytes)))
          .put("retry_count",Math.min(1000,Math.max(0,retries))).put("version_code",BuildConfig.VERSION_CODE);
    }

    private void action(String name, ActionSource source, int count, long now) {
      try {
        JSONObject row = event(name, "ok", "none", now, 0).put("action_source", source.value);
        if (count > 0) row.put("repeated_actions", count);
        writer.execute(() -> append(row));
      } catch (Exception ignored) { }
    }

    private void emit(String result,String code) {
      long now=System.nanoTime();
      try {
        JSONObject event = event(stage, result, code, now, boundedMillis(now - changed));
        if (httpStatus >= 100 && httpStatus <= 599) event.put("http_status", httpStatus);
        if (acknowledged >= 0) {
          event.put("acknowledged_bytes", Math.min(1_000_000_000_000L, acknowledged));
          if ("transfer".equals(stage)) event.put("transferred_bytes",
              Math.min(1_000_000_000_000L, acknowledged - transferBaseline));
        }
        if (retryDelay >= 0) event.put("retry_delay_ms", Math.min(604800000L, retryDelay));
        writer.execute(() -> append(event));
      } catch (Exception ignored) { }
      changed=now;
    }
  }

  private static long boundedMillis(long nanos) { return Math.min(604800000,Math.max(0,nanos/1_000_000)); }
  static String code(Throwable failure) {
    if (failure instanceof Api.RequestFailure) return ((Api.RequestFailure)failure).code;
    if (failure instanceof java.net.SocketTimeoutException) return "timeout";
    if (failure instanceof java.net.UnknownHostException) return "dns";
    if (failure instanceof javax.net.ssl.SSLException) return "tls";
    if (failure instanceof java.net.SocketException) return "connection";
    if (failure instanceof RecordingAccuracy.Failure) return "validation";
    if (failure instanceof IOException) return "device_or_storage";
    return "unknown";
  }
  private synchronized void append(JSONObject event) {
    JSONArray next=new JSONArray();
    for(int i=Math.max(0,events.length()-MAX_EVENTS+1);i<events.length();i++) next.put(events.optJSONObject(i));
    next.put(event); events=next; persist();
  }
  private void persist() {
    FileOutputStream out=null;
    try {
      out=file.startWrite(); out.write(events.toString().getBytes(StandardCharsets.UTF_8)); file.finishWrite(out);
    } catch(Exception ignored) { if(out!=null)file.failWrite(out); }
  }
  synchronized JSONArray batch(String device) {
    JSONArray result=new JSONArray();
    for(int i=0;i<events.length()&&result.length()<20;i++) {
      JSONObject event=events.optJSONObject(i);
      if(event==null||!device.equals(event.optString("device_id")))continue;
      try { JSONObject copy=new JSONObject(event.toString());copy.remove("device_id");result.put(copy); }
      catch(Exception ignored) { }
    }
    return result;
  }
  void awaitWrites() throws Exception { writer.submit(() -> {}).get(5,TimeUnit.SECONDS); }
  synchronized void acknowledge(String device, JSONArray ids) {
    Set<String> accepted=new HashSet<>();for(int i=0;i<ids.length();i++)accepted.add(ids.optString(i));
    JSONArray remaining=new JSONArray();
    for(int i=0;i<events.length();i++) {
      JSONObject event=events.optJSONObject(i);
      if(event!=null && !(device.equals(event.optString("device_id"))&&accepted.contains(event.optString("event_id"))))remaining.put(event);
    }
    events=remaining; persist();
  }
  void flush(Api api, String device, boolean enabled) {
    long now=System.nanoTime();
    if(!enabled || now<nextSendAt || !sending.compareAndSet(false,true))return;
    try {
      reporter.execute(() -> { try { send(api,device); } finally { sending.set(false); } });
    } catch(RejectedExecutionException ignored) { sending.set(false); }
  }
  private void send(Api api,String device) {
    JSONArray batch=batch(device);if(batch.length()==0)return;
    nextSendAt=System.nanoTime()+TimeUnit.SECONDS.toNanos(30);
    try {
      JSONObject result=api.call("/api/tablet/diagnostics",new JSONObject().put("device_id",device).put("events",batch));
      JSONArray ids=result.optJSONArray("accepted"), rejected=result.optJSONArray("rejected");
      if(ids!=null)acknowledge(device,ids);
      if(rejected!=null)acknowledge(device,rejected);
      failures=0;
    } catch(Exception ignored) {
      failures=Math.min(5,failures+1);
      nextSendAt=System.nanoTime()+TimeUnit.SECONDS.toNanos(Math.min(900,30L<<failures));
    }
  }
}
