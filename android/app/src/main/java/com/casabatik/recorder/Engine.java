package com.casabatik.recorder;

import android.content.Context;
import android.content.Intent;
import android.util.Log;
import java.io.File;
import java.util.HashSet;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class Engine {
  private static final String LOGO_PROCESSING = "Adding Dink Vision logo.";
  private static final String MISSING_LOCAL_VIDEO = "The saved video is no longer present on this device. Check Gallery, Files or an exported backup; this queue item cannot be processed or uploaded.";
  static long requiredRecordingBytes(int seconds) {
    return requiredRecordingBytes(seconds, 8_000_000);
  }
  static long requiredRecordingBytes(int seconds, int videoBitrate) {
    if (seconds < 1 || seconds > 7200) throw new IllegalArgumentException("Invalid recording limit.");
    if (videoBitrate < 1 || videoBitrate > 32_000_000) throw new IllegalArgumentException("Invalid recording bitrate.");
    // Live capture produces one MP4. Reserve AAC, mux overhead and space for finalization.
    return seconds * (long) (Math.max(8_000_000, videoBitrate) + 128_000) * 11 / 80 + 100_000_000L;
  }
  private static Engine instance;

  private static final class LocalOnlyException extends Exception {
    LocalOnlyException(String session) {
      super(
          "This clip is under one minute, so it was not uploaded. It remains in the app-private backup directory /data/user/0/com.casabatik.recorder/files/recordings/"
              + session
              + ".mp4.");
    }
  }

  static synchronized Engine get(Context c) {
    if (instance == null) instance = new Engine(c);
    return instance;
  }

  final Context context;
  final Vault vault;
  final Api api;
  final BackgroundTransfers backgroundTransfers;
  final EmailHistory emailHistory;
  final RecorderDiagnostics diagnostics;
  private final LiveRecordingValidation liveRecordingValidation = new LiveRecordingValidation();
  final ExecutorService work = Executors.newSingleThreadExecutor();
  final ExecutorService uploads = Executors.newSingleThreadExecutor();
  final ExecutorService exports = Executors.newSingleThreadExecutor();
  final ScheduledExecutorService heartbeat = Executors.newSingleThreadScheduledExecutor();
  final AtomicBoolean uploadWorkerRunning = new AtomicBoolean(false);
  final AtomicBoolean exportWorkerRunning = new AtomicBoolean(false);
  // Guarded by vault so manual retries cannot replace the worker's reserved job.
  private String uploadWorkerSession = "";
  private final HashSet<String> reportingUploadFailures = new HashSet<>();
  volatile String exportingSession = "", localVideoSession = "", localVideoMessage = "", localVideoError = "";
  volatile int exportPercent = 0;
  volatile boolean busy = false, stop = false;
  volatile String phase = "idle", message = "", error = "";
  volatile int elapsed = 0, countdown = 0;
  volatile int uploadPercent = -1;
  private volatile String verifyingUploadSession = "";
  volatile long recordingStartedNanos = 0;
  volatile String activeSession = "";
  volatile String captureAttempt = "";
  private volatile RecorderDiagnostics.Trace captureTrace;
  volatile String latestSavedSession = "";
  volatile boolean startHasRecoverableFootage = false;
  volatile boolean visible = false;
  volatile boolean initialized = false;
  volatile String attemptedRevision = "";
  volatile boolean cameraTestReady = false;
  volatile boolean cameraCheckedThisLaunch = false;
  volatile String confirmedCameraConnection = "", cameraTestConnection = "";
  volatile String recordingAudioInput = "";
  volatile String recordingProfile = "";
  volatile int recordingBitrate = 8_000_000;
  volatile int recordingWidth = 0, recordingHeight = 0, recordingFps = 0;
  volatile double cameraMeasuredFps = 0;
  volatile long max60Pixels = Long.MAX_VALUE;
  volatile long maxFallbackPixels = Long.MAX_VALUE;
  volatile JSONArray recordingModes = new JSONArray();
  volatile String selectedModeKey = "auto", captureModeKey = "";
  volatile long cameraConnectionGeneration = 0, cameraTestGeneration = -1;
  volatile boolean cameraTestHasAudio = false;
  volatile String cameraTestRevision = "";
  volatile String cameraTestCamera = "";
  volatile String cameraTestToken = "";
  volatile String cameraTestMode = "";
  volatile JSONObject server = new JSONObject();
  volatile boolean releaseChecked = false;
  volatile String releaseError = "";
  private volatile long releaseCheckedAt = 0;
  private volatile String lastRefreshError = "";
  private long lastQueuePresenceAt = 0;
  private final AtomicBoolean releaseCheckQueued = new AtomicBoolean(false);

  Engine(Context c) {
    this(c, null);
  }

  Engine(Context c, Api.Connections connections) {
    context = c.getApplicationContext();
    vault = new Vault(context);
    backgroundTransfers = new BackgroundTransfers(context);
    emailHistory = new EmailHistory(vault, System::currentTimeMillis);
    LocalVideoExporter.cleanupInterruptedGalleryCopy(context, vault.get("export-pending-uri"));
    try { vault.put("export-pending-uri", ""); } catch (Exception ignored) { }
    api = connections == null ? new Api(vault) : new Api(vault, connections);
    diagnostics = new RecorderDiagnostics(context.getFilesDir());
    JSONObject modes = vault.object("recording-modes");
    if (UvcCameraRecorder.connectionKey(context).equals(modes.optString("connection"))
        && modes.optInt("version") == BuildConfig.VERSION_CODE && modes.optJSONArray("modes") != null)
      recordingModes = modes.optJSONArray("modes");
    JSONObject choice = vault.object("recording-mode-choice");
    if (UvcCameraRecorder.connectionKey(context).equals(choice.optString("connection")))
      selectedModeKey = choice.optString("key", "auto");
    try { AppUpdate.validate(vault.object("android-release")); releaseChecked = true; }
    catch (Exception noCachedPolicy) { }
    // A review is intentionally limited to the current app process. Remove a stale
    // cache clip after process death so it can never be mistaken for a new test.
    cameraTestFile().delete();
    migratePendingRecording();
    VideoBranding.recoverInterruptedSwaps(new File(context.getFilesDir(), "recordings"));
    reconcileLocalQueue();
    try {
      JSONObject jar = vault.object("cookies");
      JSONObject deviceCookies = new JSONObject();
      if (jar.has("cb-kiosk")) deviceCookies.put("cb-kiosk", jar.getString("cb-kiosk"));
      vault.put("cookies", deviceCookies.toString());
    } catch (Exception e) {
      error = "Could not refresh device credentials.";
    }
    heartbeat.scheduleWithFixedDelay(
        () -> {
          if (releaseCheckedAt == 0 || System.nanoTime() - releaseCheckedAt >= TimeUnit.SECONDS.toNanos(60))
            refreshRelease();
          try {
            if (server.optBoolean("enabled")) {
              // Re-send the transition while recording so a dropped Android
              // request cannot leave the admin dashboard stuck on “starting”.
              if (busy && "recording".equals(phase) && !activeSession.isEmpty())
                api.tablet("started", new JSONObject().put("id", activeSession).put("device_info", DeviceInfo.report(context, recordingAudioInput, recordingProfile)));
              else api.tablet("heartbeat", new JSONObject().put("device_info", DeviceInfo.report(context, recordingAudioInput, recordingProfile)));
            }
          } catch (Exception ignored) { }
          // A failed metadata/heartbeat POST must not suppress an available
          // Admin command GET, or block another independently retryable report.
          refresh();
          if (server.optBoolean("enabled")) {
            try { reportBrandingPresence(); } catch (Exception ignored) { }
            try { reportWaitingQueuePresence(); } catch (Exception ignored) { }
            try { reportFilePresence(); } catch (Exception ignored) { }
            try { reportDeviceCopies(); } catch (Exception ignored) { }
          }
          try {
            if (!busy) {
              if (!uploadWorkerRunning.get()) {
                finishPendingUploadedCopies();
                reconcileMissingLocalFiles();
              }
              releaseCapturedRecordings();
              reportPendingUploadFailures();
              reportFailedCaptureIfNeeded();
            }
          } catch (Exception ignored) {
          }
          try { kickUploads(); } catch (Exception ignored) { }
          JSONObject diagnosticCapabilities=server.optJSONObject("capabilities");
          diagnostics.flush(api,vault.get("device-id"),diagnosticCapabilities!=null
              && diagnosticCapabilities.optBoolean("recorderDiagnostics"));
        },
        1,
        5,
        TimeUnit.SECONDS);
  }

  private void migratePendingRecording() {
    synchronized (vault) {
      try {
        JSONObject pending = vault.object("pending");
        if (pending.length() > 0) {
          if (!pending.has("jobId")) pending.put("jobId", pending.optString("id"));
          if (!pending.has("createdAt")) pending.put("createdAt", System.currentTimeMillis());
          if (!pending.has("status")) pending.put("status", "pending");
          upsertQueueLocked(pending);
          vault.put("pending", "");
        }
      } catch (Exception e) {
        error = "Could not restore the saved upload queue.";
      }
    }
  }

  private void reconcileLocalQueue() {
    try {
      finishPendingLocalRemovals();
      finishPendingUploadedCopies();
      reconcileMissingLocalFiles();
      File directory = new File(context.getFilesDir(), "recordings");
      File[] files = directory.listFiles((candidate, name) -> name.endsWith(".mp4"));
      if (files == null) return;
      for (File file : files) {
        String id = file.getName().substring(0, file.getName().length() - 4);
        try {
          UUID.fromString(id);
        } catch (Exception ignored) {
          continue;
        }
        JSONObject item = queueItem(id);
        if (!file.isFile() || file.length() == 0 || item.optLong("localRemovedAt") > 0) continue;
        if ("uploaded".equals(item.optString("status"))) continue;
        if (item.length() == 0) {
          saveQueueItem(
              new JSONObject()
                  .put("id", id)
                  .put("jobId", id)
                  .put("createdAt", file.lastModified() > 0 ? file.lastModified() : System.currentTimeMillis())
                  .put("bytes", file.length())
                  .put("status", "pending")
                  .put("retryCount", 0)
                  .put("localAvailable", true));
        } else if (!item.optBoolean("localAvailable", true)) {
          item.put("localAvailable", true).put("status", "pending").put("bytes", file.length())
              .put("validationPending", true).put("validationFailed", false)
              .put("brandingState", item.optBoolean("branded") ? "complete" : "failed")
              .put("presenceReportPending", true).put("lastError", "");
          saveQueueItem(item);
        } else if (backgroundTransfers.isPaused() && "uploading".equals(item.optString("status"))) {
          pauseUploadItem(item);
        } else if ("uploading".equals(item.optString("status"))) {
          int retries = item.optInt("retryCount", 0) + 1;
          item
              .put("status", retries >= 8 ? "failed" : "retrying")
              .put("retryCount", retries)
              .put("lastError", "Upload was interrupted when the app stopped.")
              .put("nextRetryAt", retries >= 8 ? 0 : System.currentTimeMillis() + 5_000L)
              .put("bytes", file.length())
              .put("failureReportPending", true)
              .put("serverRetryRequired", true);
          saveQueueItem(item);
        } else if ("recording".equals(item.optString("status"))) {
          if (!item.optBoolean("captureEndedNormally") && !item.has("captureInterruptionCode"))
            item.put("captureInterruptionCode", CameraCapture.InterruptionCode.APP_INTERRUPTED.value);
          if (item.optBoolean("liveLogoRequired") && !LiveLogoEvidence.hasSeal(file)) {
            item.put("status", "failed").put("validationFailed", true)
                .put("validationPending", false)
                .put("failureReportPending", item.has("captureInterruptionCode"))
                .put("lastError", "The recording did not finish saving. You can export the original for inspection.");
          } else {
            item.put("status", "pending").put("validationPending", true)
                .put("captureDurationMs", -1).put("lastError", "");
          }
          item.put("nextRetryAt", 0).put("bytes", file.length());
          saveQueueItem(item);
        } else if ("processing".equals(item.optString("brandingState")) && !item.optBoolean("branded", false)) {
          item.put("status", "saved_locally").put("brandingState", "failed")
              .put("lastError", "Logo processing was interrupted. The saved original will be checked and processing will resume.")
              .put("nextRetryAt", 0).put("bytes", file.length());
          saveQueueItem(item);
        }
      }
    } catch (Exception e) {
      error = "Could not reconcile locally saved videos.";
    }
  }

  void reconcileMissingLocalFiles() throws Exception {
    synchronized (vault) {
      JSONArray current = queue();
      for (int index = 0; index < current.length(); index++) {
        JSONObject item = current.optJSONObject(index);
        if (item == null || !item.optBoolean("localAvailable", true)
            || item.optString("id").equals(activeSession)
            || item.optString("id").equals(uploadWorkerSession)
            || (busy && "recording".equals(item.optString("status")))
            || "uploaded".equals(item.optString("status"))) continue;
        String sid = item.optString("id");
        try { UUID.fromString(sid); } catch (IllegalArgumentException invalid) { continue; }
        File file = new File(new File(context.getFilesDir(), "recordings"), sid + ".mp4");
        // The branding worker may be swapping files. Startup repairs its backups before this scan.
        if (file.isFile() && file.length() > 0) continue;
        item.put("localAvailable", false).put("status", "failed").put("brandingState", "failed")
            .put("lastError", MISSING_LOCAL_VIDEO).put("nextRetryAt", 0)
            .put("validationPending", false).put("validationFailed", true).put("presenceReportPending", true);
        saveQueueItem(item);
      }
    }
  }

  private JSONArray queue() {
    synchronized (vault) {
      return vault.array("upload-queue");
    }
  }

  private void upsertQueueLocked(JSONObject item) throws Exception {
    upsertQueueLocked(item, false);
  }

  private void upsertQueueLocked(JSONObject item, boolean updatingCopyReceipt) throws Exception {
    JSONArray current = vault.array("upload-queue"), updated = new JSONArray();
    String id = item.optString("id");
    boolean replaced = false;
    for (int index = 0; index < current.length(); index++) {
      JSONObject existing = current.optJSONObject(index);
      if (existing == null) continue;
      if (id.equals(existing.optString("id"))) {
        JSONObject replacement = new JSONObject(item.toString());
        // Upload/branding workers retain snapshots while copying can complete
        // independently. Those snapshots must not overwrite a newer receipt.
        if (!updatingCopyReceipt && existing.optLong("exportedAt") > 0)
          for (String key : new String[] {"exportedUri", "exportedBytes", "exportedAt", "exportReportPending"})
            if (existing.has(key)) replacement.put(key, existing.get(key));
        if (existing.optLong("localRemovedAt") > 0)
          for (String key : new String[] {"localRemovedAt", "localAvailable", "removalPending", "presenceReportPending", "lastError", "nextRetryAt"})
            if (existing.has(key)) replacement.put(key, existing.get(key));
        updated.put(replacement);
        replaced = true;
      } else updated.put(existing);
    }
    if (!replaced) updated.put(new JSONObject(item.toString()));
    vault.put("upload-queue", updated.toString());
  }

  private void saveQueueItem(JSONObject item) throws Exception {
    synchronized (vault) {
      upsertQueueLocked(item);
    }
  }

  private JSONObject queueItem(String id) {
    JSONArray current = queue();
    for (int index = 0; index < current.length(); index++) {
      JSONObject item = current.optJSONObject(index);
      if (item != null && id.equals(item.optString("id")))
        try {
          return new JSONObject(item.toString());
        } catch (Exception ignored) {
        }
    }
    return new JSONObject();
  }

  private boolean hasLocalQueue() {
    JSONArray current = queue();
    for (int index = 0; index < current.length(); index++) {
      JSONObject item = current.optJSONObject(index);
      if (item != null && item.optBoolean("localAvailable", true)) return true;
    }
    return false;
  }

  private JSONObject latestRecoverableRecording() {
    JSONArray current = queue();
    JSONObject latest = null;
    for (int index = 0; index < current.length(); index++) {
      JSONObject item = current.optJSONObject(index);
      if (item == null || !"failed".equals(item.optString("status"))
          || !item.optBoolean("localAvailable", true) || !belongsToCurrentDevice(item)) continue;
      String id = item.optString("id");
      try {
        UUID.fromString(id);
      } catch (Exception ignored) {
        continue;
      }
      File file = new File(new File(context.getFilesDir(), "recordings"), id + ".mp4");
      if (!file.isFile() || file.length() < 1024) continue;
      if (latest == null || item.optLong("createdAt") > latest.optLong("createdAt")) latest = item;
    }
    if (latest == null) return new JSONObject();
    try {
      return new JSONObject(latest.toString());
    } catch (Exception ignored) {
      return new JSONObject();
    }
  }

  private JSONArray publicQueue() throws Exception {
    JSONArray result = new JSONArray(), current = queue();
    for (int index = 0; index < current.length(); index++) {
      JSONObject item = current.optJSONObject(index);
      if (item == null || !item.optBoolean("localAvailable", true)
          || !belongsToCurrentDevice(item) || "recording".equals(item.optString("status"))) continue;
      try { UUID.fromString(item.optString("id")); } catch (Exception invalid) { continue; }
      File file = new File(new File(context.getFilesDir(), "recordings"), item.optString("id") + ".mp4");
      if (!file.isFile() || file.length() < 1) continue;
      result.put(
          new JSONObject()
              .put("id", item.optString("id"))
              .put("jobId", item.optString("jobId", item.optString("id")))
              .put("status", item.optString("status", "saved_locally"))
              .put("progress", item.optInt("progress", 0))
              .put("uploadedBytes", item.optLong("uploadedBytes"))
              .put("verifyingUpload", item.optString("id").equals(verifyingUploadSession))
              .put("retryCount", item.optInt("retryCount", 0))
              .put("lastError", item.optString("lastError"))
              .put("createdAt", item.optLong("createdAt"))
              .put("recipients", item.optJSONArray("recipients") == null ? new JSONArray() : item.optJSONArray("recipients"))
              .put("bytes", file.length())
              .put("durationMs", item.optLong("durationMs"))
              .put("captureInterruptionCode", item.optString("captureInterruptionCode"))
              .put("captureInterruptedAt", item.optLong("captureInterruptedAt"))
              .put("captureReleased", item.optBoolean("captureReleased", false))
              .put("localAvailable", true)
              .put("brandingState", item.optString("brandingState"))
              .put("brandingProgress", item.optInt("brandingProgress", -1))
              .put("exportReportPending",item.optBoolean("exportReportPending"))
              .put("validationFailed", item.optBoolean("validationFailed"))
              .put("validationPending", item.optBoolean("validationPending"))
              .put("canRemove", !busy && !uploadWorkerRunning.get() && !exportWorkerRunning.get()
                  && removableLocalItem(item) && !item.optString("exportedUri").isEmpty()
                  && item.optLong("exportedBytes") == file.length())
              .put("exported", !item.optString("exportedUri").isEmpty()));
    }
    return result;
  }

  private void reportQueueItem(JSONObject item) throws Exception {
    JSONObject report =
        new JSONObject()
            .put("id", item.getString("id"))
            .put("status", item.optString("status", "saved_locally"))
            .put("progress", item.optInt("progress", 0))
            .put("retry_count", item.optInt("retryCount", 0))
            .put("last_error", item.optString("lastError"))
            .put("local_available", item.optBoolean("localAvailable", true))
            .put("created_at", item.optLong("createdAt"))
            .put("bytes", item.optLong("bytes"))
            .put("uploaded_bytes", "uploaded".equals(item.optString("status")) ? item.optLong("bytes") : 0);
    if (item.has("brandingState"))
      report.put("branding_state", item.optString("brandingState"));
    JSONObject capabilities = server.optJSONObject("capabilities");
    if (capabilities != null && capabilities.optBoolean("brandingProgressReporting") && item.has("brandingProgress"))
      report.put("branding_progress", item.optInt("brandingProgress"));
    if (item.has("durationMs")) report.put("duration_ms", item.optLong("durationMs"));
    api.tablet("queue-report", report);
  }

  private void reportBrandingPresence() throws Exception {
    if (!uploadWorkerRunning.get()) return;
    JSONArray current = queue();
    for (int index = 0; index < current.length(); index++) {
      JSONObject item = current.optJSONObject(index);
      if (item == null || !belongsToCurrentDevice(item) || !"processing".equals(item.optString("brandingState"))) continue;
      File file = new File(new File(context.getFilesDir(), "recordings"), item.getString("id") + ".mp4");
      if (file.isFile() && file.length() > 0) reportQueueItem(new JSONObject(item.toString()));
    }
  }

  void reportWaitingQueuePresence() throws Exception {
    JSONObject capabilities = server.optJSONObject("capabilities");
    if (capabilities == null || !capabilities.optBoolean("queuePresenceReporting")) return;
    long now = android.os.SystemClock.elapsedRealtime();
    if (now - lastQueuePresenceAt < 30_000L) return;
    JSONArray current = queue();
    for (int index = 0; index < current.length(); index++) {
      JSONObject item = current.optJSONObject(index);
      if (item == null || !belongsToCurrentDevice(item) || !waitingForWorker(item)) continue;
      File file = new File(new File(context.getFilesDir(), "recordings"), item.getString("id") + ".mp4");
      if (file.isFile() && file.length() > 0) {
        try { api.tablet("queue-presence", new JSONObject().put("id", item.getString("id"))); }
        catch (Exception ignored) { /* One rejected item must not starve other waiting files. */ }
      }
    }
    lastQueuePresenceAt = now;
  }

  static boolean waitingForWorker(JSONObject item) {
    return item.optBoolean("localAvailable", true)
        && java.util.Arrays.asList("saved_locally", "pending", "retrying").contains(item.optString("status"))
        && !"processing".equals(item.optString("brandingState"));
  }

  private int queuedWorkCount() {
    int count=0;JSONArray items=queue();
    for(int i=0;i<items.length();i++) {
      JSONObject item=items.optJSONObject(i);
      if(item!=null && belongsToCurrentDevice(item) && item.optBoolean("localAvailable",true)
          && java.util.Arrays.asList("saved_locally","pending","retrying","uploading").contains(item.optString("status")))count++;
    }
    return count;
  }

  void reportFilePresence() throws Exception {
    JSONArray current = queue();
    for (int index = 0; index < current.length(); index++) {
      JSONObject item = current.optJSONObject(index);
      if (item == null || !item.optBoolean("presenceReportPending") || !belongsToCurrentDevice(item)) continue;
      reportQueueItem(item);
      synchronized (vault) {
        // Ordinary worker merges preserve tombstone flags against stale writes.
        // A confirmed delivery must acknowledge that flag explicitly instead.
        JSONArray latestQueue = vault.array("upload-queue");
        for (int i = 0; i < latestQueue.length(); i++) {
          JSONObject latest = latestQueue.optJSONObject(i);
          if (latest == null || !item.getString("id").equals(latest.optString("id"))) continue;
          if (belongsToCurrentDevice(latest)
              && latest.optBoolean("localAvailable", true) == item.optBoolean("localAvailable", true)
              && latest.optLong("localRemovedAt") == item.optLong("localRemovedAt")
              && latest.optString("status").equals(item.optString("status"))) {
            latest.put("presenceReportPending", false);
            vault.put("upload-queue", latestQueue.toString());
          }
          break;
        }
      }
    }
  }

  void reportDeviceCopies() throws Exception {
    JSONObject capabilities=server.optJSONObject("capabilities");
    if(capabilities==null || !capabilities.optBoolean("deviceCopyReporting")) return;
    JSONArray current=queue();
    for(int index=0;index<current.length();index++){
      JSONObject item=current.optJSONObject(index);
      if(item==null || !item.optBoolean("exportReportPending") || !belongsToCurrentDevice(item))continue;
      long exportedAt=item.optLong("exportedAt");
      api.tablet("device-copy",new JSONObject().put("id",item.getString("id")).put("bytes",item.optLong("exportedBytes")));
      synchronized(vault){
        JSONObject latest=queueItem(item.getString("id"));
        if(latest.optLong("exportedAt")==exportedAt){latest.put("exportReportPending",false);upsertQueueLocked(latest,true);}
      }
    }
  }

  private void releaseCapturedRecording(JSONObject item) throws Exception {
    boolean released = item.optBoolean("captureReleased", false);
    JSONObject remote = server.optJSONObject("session");
    boolean stillHeld = remote != null && item.optString("id").equals(remote.optString("id"))
        && activeCaptureStatus(remote.optString("status"));
    if (released && !stillHeld) return;
    String status = item.optString("status", "saved_locally");
    if (!released && !java.util.Arrays.asList("saved_locally", "pending", "retrying", "uploading")
        .contains(status)) return;
    String sid = item.optString("id");
    UUID.fromString(sid);
    File file = new File(new File(context.getFilesDir(), "recordings"), sid + ".mp4");
    if (!released && (!file.isFile() || file.length() < 1)) return;
    api.tablet("captured", captureEventFields(item));
    item.put("captureReleased", true);
    JSONObject latest = queueItem(sid);
    if (latest.length() > 0) {
      latest.put("captureReleased", true);
      saveQueueItem(latest);
    }
  }

  private void releaseCapturedRecordings() {
    JSONArray current = queue();
    for (int index = 0; index < current.length(); index++) {
      JSONObject item = current.optJSONObject(index);
      if (item == null || !item.optBoolean("localAvailable", true) || !belongsToCurrentDevice(item))
        continue;
      try {
        releaseCapturedRecording(new JSONObject(item.toString()));
      } catch (Exception ignored) {
        // A later heartbeat, recording start, or upload attempt retries this
        // idempotent release while the local video remains authoritative.
      }
    }
  }

  // The recording-start path reconciles only the server's actual capture holder.
  // Historical files remain the responsibility of the background heartbeat.
  void releaseBlockingCapture() throws Exception {
    JSONObject remote=server.optJSONObject("session");
    if(remote==null || !activeCaptureStatus(remote.optString("status")))return;
    JSONObject item=queueItem(remote.optString("id"));
    if(item.length()==0 || !belongsToCurrentDevice(item))return;
    if ("failed".equals(item.optString("status"))) {
      api.tablet("failed", captureEventFields(item));
      return;
    }
    if (!item.optBoolean("localAvailable",true)) return;
    if(!java.util.Arrays.asList("saved_locally","pending","retrying","uploading").contains(item.optString("status")))return;
    releaseCapturedRecording(item);
  }

  synchronized boolean claim() {
    if (busy || pairingRequested.get()) return false;
    busy = true;
    error = "";
    stop = false;
    return true;
  }

  void refresh() {
    refresh(false);
  }

  private void refresh(boolean checkEnrollmentNow) {
    try {
      JSONObject next = api.call("/api/tablet", null);
      JSONObject capabilities = next.optJSONObject("capabilities");
      if (!busy && hasPendingEnrollment()) {
        if (capabilities != null && capabilities.optBoolean("enrollmentRecovery")) {
          if (recoverPendingEnrollment(checkEnrollmentNow)) next = api.call("/api/tablet", null);
        } else if (checkEnrollmentNow) {
          error = "This server cannot check the previous enrollment. Retry the invitation from the same Admin site as this app.";
        }
      }
      updateServer(next);
      initialized = true;
      reconcileServerUploadRequests();
      boolean reconnected = !lastRefreshError.isEmpty();
      if (reconnected && lastRefreshError.equals(error)) error = "";
      lastRefreshError = "";
      if (reconnected && !busy && "idle".equals(phase) && hasStoredEnrollment())
        message = server.optBoolean("enabled") ? "Connection restored. Your saved enrollment is still active."
            : "The saved registration is inactive or unrecognized. Ask Admin to check this device.";
    } catch (Exception e) {
      String previous = lastRefreshError;
      lastRefreshError = e.getMessage() == null ? "Connection unavailable. Enrollment is still saved." : e.getMessage();
      if (!busy && (error == null || error.isEmpty() || previous.equals(error))) error = lastRefreshError;
    }
  }

  void refreshRelease() {
    try {
      JSONObject policy = AppUpdate.validate(api.call("/api/android/release", null));
      vault.put("android-release", policy.toString());
      releaseChecked = true;
      releaseError = "";
      releaseCheckedAt = System.nanoTime();
    } catch (Exception failure) {
      releaseError = "Could not check for an Android update. Check the connection and try again.";
      // A known mandatory update remains mandatory during a connection failure.
      releaseCheckedAt = System.nanoTime() - TimeUnit.SECONDS.toNanos(55);
    }
  }

  void checkForUpdate() {
    if (!releaseCheckQueued.compareAndSet(false, true)) return;
    heartbeat.execute(() -> { try { refreshRelease(); } finally { releaseCheckQueued.set(false); } });
  }

  boolean updateRequired() {
    return AppUpdate.required(vault.object("android-release"), BuildConfig.VERSION_CODE);
  }

  boolean updateBlocksPlayer() { return !releaseChecked || updateRequired(); }

  void updateServer(JSONObject next) throws Exception {
    api.acceptCurrentResponse(next, () -> applyServerState(next));
  }

  private void applyServerState(JSONObject next) throws Exception {
    JSONObject device = next.optJSONObject("device");
    String id = device == null ? "" : device.optString("id");
    if (!(next.opt("enabled") instanceof Boolean)
        || (next.getBoolean("enabled") && (device == null || id.isEmpty() || device.isNull("id"))))
      throw new Exception("Invalid tablet assignment response. Retry connection.");
    if (!next.getBoolean("enabled")) id = "";
    if (!id.equals(vault.get("device-id"))) vault.put("device-id", id);
    server = next;
    JSONObject current = next.optJSONObject("session");
    if (busy && !activeSession.isEmpty() && current != null
        && activeSession.equals(current.optString("id"))
        && !current.isNull("stop_requested_at")
        && !current.optString("stop_requested_at").isEmpty()) {
      RecorderDiagnostics.Trace trace = captureTrace;
      if (!stop && trace != null) trace.stopRequested(RecorderDiagnostics.ActionSource.ADMIN);
      stop = true;
    }
    JSONArray reports = next.optJSONArray("queue");
    if (reports != null) for (int index = 0; index < reports.length(); index++) {
      JSONObject remote = reports.optJSONObject(index);
      if (remote == null) continue;
      JSONObject local = queueItem(remote.optString("session_id"));
      JSONObject session = remote.optJSONObject("recording_sessions");
      if (session != null && "ready".equals(session.optString("status"))
          && java.util.Arrays.asList("uploaded", "complete").contains(remote.optString("upload_state"))
          && belongsToCurrentDevice(local) && !uploadWorkerSession.equals(local.optString("id"))
          && java.util.Arrays.asList("pending", "retrying", "failed", "uploading").contains(local.optString("status"))) {
        String sid = local.getString("id");
        UUID.fromString(sid);
        File file = new File(new File(context.getFilesDir(), "recordings"), sid + ".mp4");
        if (!file.exists() || (file.isFile() && file.length() == remote.optLong("bytes"))) {
          // The process may have stopped between verified cloud upload and
          // the local journal write, including on its last automatic attempt.
          persistVerifiedUpload(local);
        }
      }
      if (remote.optBoolean("local_available") && !id.isEmpty() && session != null
          && !activeCaptureStatus(session.optString("status"))) {
        String sid = remote.optString("session_id");
        try { UUID.fromString(sid); } catch (Exception invalid) { continue; }
        File file = new File(new File(context.getFilesDir(), "recordings"), sid + ".mp4");
        // A reinstall can erase the local journal while leaving a stale server
        // availability report. Bind only files/IDs in this authenticated device's manifest.
        if (local.length() == 0 || local.optString("device").isEmpty()) {
          long created = remote.optLong("client_created_at", 0);
          if (created <= 0) try { created = java.time.OffsetDateTime.parse(remote.optString("client_created_at")).toInstant().toEpochMilli(); }
          catch (Exception unknownDate) { created = file.lastModified() > 0 ? file.lastModified() : System.currentTimeMillis(); }
          if (file.isFile() && file.length() > 0) {
            String restoredStatus = remote.optString("upload_state");
            local = new JSONObject().put("id", sid).put("jobId", remote.optString("job_id", sid))
                .put("device", id).put("status", java.util.Arrays.asList("local_only", "failed", "uploaded").contains(restoredStatus) ? restoredStatus : "pending").put("localAvailable", true)
                .put("bytes", file.length()).put("audioExpected", true)
                .put("branded", "complete".equals(remote.optString("branding_state")))
                .put("brandingState", remote.optString("branding_state"))
                .put("retryCount", remote.optInt("retry_count"));
          } else {
            local = new JSONObject().put("id", sid).put("jobId", remote.optString("job_id", sid))
                .put("device", id).put("status", "failed").put("localAvailable", false)
                .put("presenceReportPending", true).put("validationFailed", true)
                .put("lastError", MISSING_LOCAL_VIDEO).put("brandingState", "failed")
                .put("retryCount", remote.optInt("retry_count"));
          }
          local.put("createdAt", created);
          if (!remote.isNull("duration_ms")) local.put("durationMs", remote.optLong("duration_ms"));
          if (!session.isNull("capture_interruption_code")) {
            local.put("captureInterruptionCode", session.getString("capture_interruption_code"));
            if (!session.isNull("capture_interrupted_at")) try {
              long interruptedAt = java.time.OffsetDateTime.parse(session.getString("capture_interrupted_at")).toInstant().toEpochMilli();
              local.put("captureInterruptedAt", interruptedAt);
            } catch (java.time.format.DateTimeParseException ignored) { }
          }
          if (session.optBoolean("capture_inspection_required") && local.optBoolean("localAvailable"))
            local.put("status", "failed").put("validationFailed", true).put("lastError", remote.optString("last_error"));
          saveQueueItem(local);
        }
      }
      JSONObject capabilities=next.optJSONObject("capabilities");
      if (local.length()>0 && belongsToCurrentDevice(local) && session!=null && !activeCaptureStatus(session.optString("status"))
          && local.optBoolean("localAvailable",true) && remote.optLong("bytes")<=0
          && capabilities!=null && capabilities.optBoolean("localFileSizeReporting")) {
        File file=new File(new File(context.getFilesDir(),"recordings"),remote.optString("session_id")+".mp4");
        if(file.isFile()&&file.length()>0){local.put("bytes",file.length()).put("presenceReportPending",true);saveQueueItem(local);}
      }
      if (local.length() == 0 || !belongsToCurrentDevice(local) || session == null || local.has("recipients")) continue;
      JSONArray recipients = session.optJSONArray("recipient_emails");
      if (recipients != null && recipients.length() > 0 && recipients.length() <= 4) {
        local.put("recipients", recipients);
        saveQueueItem(local);
      }
    }
  }

  private final AtomicBoolean retryQueued = new AtomicBoolean();

  void retryConnection() {
    if ((!hasStoredEnrollment() && !hasPendingEnrollment()) || !retryQueued.compareAndSet(false, true)) return;
    heartbeat.execute(() -> {
      try {
        if (!releaseChecked) refreshRelease();
        refresh(true);
      } finally { retryQueued.set(false); }
    });
  }

  private String connectionStatus() {
    String network = ConnectionNotice.message(context, api.serverReachable);
    if (retryQueued.get()) return "Reconnecting…";
    if (!hasStoredEnrollment()) {
      if (hasPendingEnrollment() && network.isEmpty()) return "Enrollment confirmation pending.";
      return network;
    }
    if (network.startsWith("No internet")) return "Offline — enrollment is saved.";
    if (!lastRefreshError.isEmpty()) return "Server unavailable — enrollment is saved.";
    if (hasPendingEnrollment()) return "Enrollment confirmation pending.";
    if (!initialized) return "Connecting…";
    return server.optBoolean("enabled") ? "" : "Registration inactive — contact Admin.";
  }

  void refreshConfiguration() {
    if (!claim()) return;
    message = "Checking this tablet’s saved assignment…";
    work.execute(
        () -> {
          try {
            updateServer(api.call("/api/tablet", null));
            initialized = true;
            reconcileServerUploadRequests();
            error = "";
            lastRefreshError = "";
            if (server.optBoolean("enabled") && cameraMode().isEmpty()) {
              message =
                  "This tablet is enrolled. Open Device setup and choose its camera without entering another code.";
            } else message = server.optBoolean("enabled")
                ? "Connection checked. Your saved enrollment is still active."
                : "The saved registration is inactive or unrecognized. Ask Admin to check this device.";
          } catch (Exception e) {
            error = e.getMessage() == null ? "Connection unavailable. Enrollment is still saved." : e.getMessage();
            lastRefreshError = error;
            message = "The saved enrollment is unchanged. Check the connection and try again.";
          } finally {
            busy = false;
          }
        });
  }

  boolean hasStoredEnrollment() {
    return !vault.object("cookies").optString("cb-kiosk").isEmpty();
  }

  private void reconcileServerUploadRequests() {
    JSONArray remoteQueue = server.optJSONArray("queue");
    if (remoteQueue == null) return;
    for (int index = 0; index < remoteQueue.length(); index++) {
      JSONObject remote = remoteQueue.optJSONObject(index);
      if (remote == null
          || !java.util.Arrays.asList("pending", "retrying")
              .contains(remote.optString("upload_state"))) continue;
      String id = remote.optString("session_id");
      JSONObject local = queueItem(id);
      if (interruptedNeedsInspection(local)) continue;
      File file = new File(new File(context.getFilesDir(), "recordings"), id + ".mp4");
      String localFailureUpdate = local.optString("failureServerUpdatedAt");
      String remoteUpdate = remote.optString("upload_updated_at");
      if (!"failed".equals(local.optString("status"))
          || local.optBoolean("failureReportPending")
          || !belongsToCurrentDevice(local)
          || !local.optBoolean("localAvailable", true)
          || !file.isFile()
          || file.length() < 1024
          || !newerServerUpdate(remoteUpdate, localFailureUpdate)) continue;
      try {
        local
            .put("status", "pending")
            .put("retryCount", 0)
            .put("serverRetryRequired", true)
            .put("failureReportPending", false)
            .put("lastError", "")
            .put("nextRetryAt", 0);
        saveQueueItem(local);
      } catch (Exception ignored) {
      }
    }
  }

  private boolean newerServerUpdate(String current, String previous) {
    if (previous.isEmpty()) return true; // Older APKs did not save an acknowledgement.
    try {
      return java.time.OffsetDateTime.parse(current).toInstant()
          .isAfter(java.time.OffsetDateTime.parse(previous).toInstant());
    } catch (java.time.format.DateTimeParseException invalid) {
      return false;
    }
  }

  private void reportUploadFailure(JSONObject item) throws Exception {
    JSONObject report = captureEventFields(item)
            .put("retry_count", item.optInt("retryCount"))
            .put("retrying", "retrying".equals(item.optString("status")))
            .put("last_error", item.optString("lastError"))
            .put("validation_failed", item.optBoolean("validationFailed"))
            .put("local_available", item.optBoolean("localAvailable", true))
            .put("branding_state", item.optString("brandingState"));
    if (supportsUploadBackoff() && "retrying".equals(item.optString("status")))
      report.put("retry_delay_ms", Math.max(0, Math.min(900_000L, item.optLong("nextRetryAt") - System.currentTimeMillis())));
    JSONObject response = api.tablet("upload-failed", report);
    synchronized (vault) {
      JSONObject current = queueItem(item.getString("id"));
      if (!current.optBoolean("failureReportPending")
          || current.optInt("retryCount") != item.optInt("retryCount")
          || !current.optString("status").equals(item.optString("status"))) return;
      current.put("failureReportPending", false);
      if ("retrying".equals(response.optString("upload_state")) && !response.isNull("upload_retry_at")) {
        try {
          long retryAt = java.time.OffsetDateTime.parse(response.getString("upload_retry_at")).toInstant().toEpochMilli();
          long reportedAt = java.time.OffsetDateTime.parse(response.getString("upload_updated_at")).toInstant().toEpochMilli();
          long delay = Math.max(0, Math.min(900_000L, retryAt - reportedAt));
          current.put("nextRetryAt", Math.max(current.optLong("nextRetryAt"), System.currentTimeMillis() + delay));
        } catch (Exception ignored) { /* Keep the local deadline if the server does not provide one. */ }
      }
      // Use the server's acknowledged time, never the tablet's wall clock.
      // A newer administrator request is the only remote state that resets a failure.
      current.put("failureServerUpdatedAt",
          "failed".equals(response.optString("upload_state"))
              ? response.optString("upload_updated_at") : "");
      saveQueueItem(current);
    }
  }

  private void reportPendingUploadFailures() {
    JSONArray current = queue();
    for (int index = 0; index < current.length(); index++) {
      JSONObject item = current.optJSONObject(index);
      if (item == null || !item.optBoolean("failureReportPending")
          || !belongsToCurrentDevice(item)
          || !java.util.Arrays.asList("failed", "retrying").contains(item.optString("status")))
        continue;
      String sid = item.optString("id");
      synchronized (vault) {
        if (sid.equals(uploadWorkerSession) || !reportingUploadFailures.add(sid)) continue;
      }
      try {
        JSONObject latest = queueItem(sid);
        if (latest.optBoolean("failureReportPending")) reportUploadFailure(latest);
      } catch (Exception ignored) {
        // Keep the pending report durable until the device can contact the server.
      } finally {
        synchronized (vault) { reportingUploadFailures.remove(sid); }
      }
    }
  }

  private boolean activeCaptureStatus(String status) {
    return java.util.Arrays.asList("requested", "starting", "recording", "finalizing")
        .contains(status);
  }

  private void reportFailedCaptureIfNeeded() {
    JSONObject session = server.optJSONObject("session");
    if (session == null || !activeCaptureStatus(session.optString("status"))) return;
    String id = session.optString("id");
    JSONObject item = queueItem(id);
    if (!"failed".equals(item.optString("status")) || !belongsToCurrentDevice(item)) return;
    try {
      api.tablet("failed", captureEventFields(item));
      refresh();
    } catch (Exception ignored) {
    }
  }

  String snapshot() {
    try {
      JSONObject device = server.optJSONObject("device");
      JSONObject recovery = latestRecoverableRecording();
      JSONObject previous = server.optJSONObject("session");
      JSONObject previousLocal = previous == null ? new JSONObject() : queueItem(previous.optString("id"));
      long currentElapsedMillis =
          "recording".equals(phase) && recordingStartedNanos > 0
              ? (System.nanoTime() - recordingStartedNanos) / 1_000_000L
              : Math.max(0L, (long) elapsed * 1_000L);
      int currentElapsed = (int) (currentElapsedMillis / 1_000L);
      JSONObject s =
          new JSONObject()
              .put("enabled", server.optBoolean("enabled"))
              .put("enrolled", hasStoredEnrollment())
              .put("initialized", initialized)
              .put("registrationInactive", hasStoredEnrollment() && initialized && !server.optBoolean("enabled") && lastRefreshError.isEmpty())
              .put("connectionNotice", connectionStatus())
              .put("connectionRetry", (hasPendingEnrollment() || (hasStoredEnrollment() && !lastRefreshError.isEmpty())) && !retryQueued.get())
              .put("enrollmentPending", hasPendingEnrollment())
              .put("enrollmentChecking", retryQueued.get())
              .put("enrollmentOrigin", Api.ORIGIN)
              .put("tabletPairing", tabletPairing)
              .put("tabletPairingBusy", pairingRequested.get())
              .put("busy", busy)
              .put("phase", phase)
              .put("message", message)
              .put("error", error)
              .put("version", BuildConfig.VERSION_NAME)
              .put("update", vault.object("android-release"))
              .put("updateChecking", !releaseChecked)
              .put("updateRequired", updateRequired())
              .put("updateError", releaseError)
              .put("updateLoading", releaseCheckQueued.get())
              .put("elapsed", Math.max(0, currentElapsed))
              .put("elapsedMs", Math.max(0L, currentElapsedMillis))
              .put("uploadPercent", uploadPercent)
              .put("countdown", countdown)
              .put("captureAttempt", captureAttempt)
              .put("pending", hasLocalQueue())
              .put("recoverable", recovery.length() > 0)
              .put("startHasRecoverableFootage", startHasRecoverableFootage)
              .put("previousCaptureReleased", !busy && belongsToCurrentDevice(previousLocal)
                  && previousLocal.optBoolean("captureReleased") && !"recording".equals(previousLocal.optString("status")))
              .put("recoveryKind", recovery.length() == 0 ? "" :
                  recovery.has("durationMs") ? "upload" : "partial")
              .put("savedVideos", publicQueue())
              .put("localDeviceKnown", !currentDeviceId().isEmpty())
              .put("exportingSession", exportingSession)
              .put("exportPercent", exportPercent)
              .put("localVideoMessage", localVideoMessage)
              .put("localVideoSession", localVideoSession)
              .put("localVideoError", localVideoError)
              .put("tested", cameraReady(device))
              .put("cameraMode", cameraMode())
              .put("testReady", cameraTestReady)
              .put("testConfirmable", canConfirmCameraTest())
              .put("testHasAudio", cameraTestHasAudio)
              .put("testAudioInput", recordingAudioInput)
              .put("recordingProfile", recordingProfile)
              .put("logoPipeline", LiveLogoProcessor.status)
              .put("recordingModes", recordingModes)
              .put("selectedRecordingMode", selectedModeKey)
              .put("testToken", cameraTestToken)
              .put("audio", device != null && !device.optString("audio_device").isEmpty())
              .put("maxSeconds", server.optInt("maxSeconds", 900));
      if (server.optJSONArray("courts") != null && server.getJSONArray("courts").length() > 0)
        s.put("court", server.getJSONArray("courts").getJSONObject(0).optString("name"));
      if (server.optJSONObject("session") != null)
        s.put("session", server.getJSONObject("session"));
      return s.toString();
    } catch (Exception e) {
      return "{}";
    }
  }

  void startService(boolean cameraActive, boolean uploadActive) {
    if (cameraActive && !DeviceCameraRecorder.hasPermissions(context))
      throw new IllegalStateException(
          "Open Device setup and allow camera and microphone access first.");
    if (cameraActive)
      context.startForegroundService(new Intent(context, RecorderService.class)
          .putExtra(RecorderService.EXTRA_CAMERA_ACTIVE, true));
    if (uploadActive) {
      if (backgroundTransfers.isPaused()) throw new IllegalStateException(BackgroundTransfers.PAUSED);
      try { context.startForegroundService(new Intent(context, TransferService.class)); }
      catch (RuntimeException denied) { pauseBackgroundTransfers(); throw denied; }
    }
  }

  boolean usesDeviceCamera() {
    JSONObject device = server.optJSONObject("device");
    return device != null && "android-camera-v1".equals(device.optString("video_device"));
  }

  String cameraMode() {
    if (usesDeviceCamera()) return "device";
    return "";
  }

  void clearCameraCache() {
    requireCameraCheck();
    try {
      vault.put("camera", "");
      vault.put("camera-revision", "");
    } catch (Exception ignored) {
    }
  }

  void requireCameraCheck() {
    cameraCheckedThisLaunch = false;
    confirmedCameraConnection = "";
  }

  void cameraConnectionChanged() {
    cameraConnectionGeneration++;
    max60Pixels = Long.MAX_VALUE;
    maxFallbackPixels = Long.MAX_VALUE;
    cameraMeasuredFps = 0;
    recordingModes = new JSONArray();
    selectedModeKey = "auto";
    captureModeKey = "";
    try { vault.put("camera-performance", ""); } catch (Exception ignored) { }
    requireCameraCheck();
    if (!busy) clearCameraTestReview();
  }

  File cameraTestDirectory() {
    File directory = new File(context.getCacheDir(), "camera-test");
    if (!directory.isDirectory()) directory.mkdirs();
    return directory;
  }

  File cameraTestFile() {
    return new File(cameraTestDirectory(), "clip.mp4");
  }

  private void clearCameraTestReview() {
    cameraTestReady = false;
    cameraTestHasAudio = false;
    cameraTestRevision = "";
    cameraTestCamera = "";
    cameraTestToken = "";
    cameraTestFile().delete();
  }

  void configureCamera(JSONObject configuration) {
    if (!server.optBoolean("enabled")) {
      error = "Enroll this tablet before choosing its camera.";
      return;
    }
    if (!visible || !claim()) return;
    phase = "configuring";
    max60Pixels = Long.MAX_VALUE;
    maxFallbackPixels = Long.MAX_VALUE;
    cameraMeasuredFps = 0;
    message = "Saving this tablet’s camera setup…";
    work.execute(
        () -> {
          boolean saved = false;
          try {
            JSONObject request = new JSONObject(configuration.toString());
            JSONObject currentDevice = server.optJSONObject("device");
            if (currentDevice == null || currentDevice.optString("config_revision").isEmpty())
              throw new Exception("Refresh this tablet before changing its camera settings.");
            request
                .put("action", "configure")
                .put("expected_revision", currentDevice.getString("config_revision"));
            api.call("/api/tablet/camera", request);
            vault.put("camera-performance", "");
            clearCameraCache();
            attemptedRevision = "";
            updateServer(api.call("/api/tablet", null));
            initialized = true;
            reconcileServerUploadRequests();
            error = "";
            phase = "idle";
            message = "Camera setup saved. Starting the required camera test…";
            saved = true;
          } catch (Exception e) {
            error = e.getMessage();
            phase = "error";
            message = "Camera setup could not be saved.";
          } finally {
            busy = false;
          }
          if (saved && visible) syncCamera();
        });
  }

  long captureCamera(
      JSONObject camera,
      File file,
      int seconds,
      int countInSeconds,
      CameraCapture.Listener listener)
      throws Exception {
    if (!"device".equals(camera.optString("type")))
      throw new Exception("Only a USB or built-in Android camera is supported.");
    return DeviceCameraRecorder.capture(
        context, file, seconds, countInSeconds, () -> stop, listener, max60Pixels, maxFallbackPixels, captureModeKey);
  }

  boolean selectRecordingMode(String key) {
    if (key == null || key.isEmpty()) return true; // Older UI actions retain the current choice.
    if (busy || key.length() > 40) return false;
    boolean allowed = "auto".equals(key);
    for (int n=0;n<recordingModes.length();n++) {
      JSONObject mode=recordingModes.optJSONObject(n);
      if(mode!=null && key.equals(mode.optString("key")) && mode.optBoolean("supported"))allowed=true;
    }
    if(!allowed){error="That recording mode is unavailable on this camera/device. Select another mode.";return false;}
    if (!key.equals(selectedModeKey)) {
      requireCameraCheck();
      cameraTestMode = "";
    }
    selectedModeKey=key;
    try { vault.put("recording-mode-choice",new JSONObject().put("connection",UvcCameraRecorder.connectionKey(context)).put("key",key).toString()); }
    catch(Exception failure){error="Could not save the video quality selection.";return false;}
    return true;
  }

  private void reportRecordingModes(java.util.List<RecordingProfile> modes) throws Exception {
    recordingModes=RecordingProfile.describe(modes);
    vault.put("recording-modes",new JSONObject().put("connection",UvcCameraRecorder.connectionKey(context))
        .put("version",BuildConfig.VERSION_CODE).put("modes",recordingModes).toString());
  }

  boolean expectsAudio(JSONObject camera) {
    return "device".equals(camera.optString("type"));
  }

  void finishWork() {
    busy = false;
    RecorderService.stopWhenIdle();
    refresh();
  }

  private void finishCaptureWork() {
    busy = false;
    RecorderService.stopWhenIdle();
    try { heartbeat.execute(this::refresh); }
    catch (RejectedExecutionException ignored) { }
  }

  private final Object enrollmentState = new Object();
  private long nextEnrollmentRecoveryNanos;

  private boolean hasPendingEnrollment() {
    return !vault.get("pending-enrollment").isEmpty();
  }

  private boolean recoverPendingEnrollment(boolean immediate) throws Exception {
    synchronized (enrollmentState) {
      JSONObject attempt = vault.object("pending-enrollment");
      long now = System.nanoTime();
      if (attempt.length() == 0 ||
          (!immediate && nextEnrollmentRecoveryNanos != 0 && now - nextEnrollmentRecoveryNanos < 0)) return false;
      nextEnrollmentRecoveryNanos = now + TimeUnit.SECONDS.toNanos(60);
      try {
        api.call("/api/tablet/enroll", attempt.put("recover", true));
      } catch (Api.RequestFailure failure) {
        if ("enrollment_not_committed".equals(failure.code)) {
          error = "Enrollment was not confirmed. Retry the same invitation if it is still valid.";
          return false;
        }
        throw failure;
      }
      finishEnrollment();
      return true;
    }
  }

  private static final String TABLET_PAIRING = "tablet-pairing";
  private volatile JSONObject tabletPairing = new JSONObject();
  private final java.util.concurrent.atomic.AtomicBoolean pairingRequested = new java.util.concurrent.atomic.AtomicBoolean();
  private volatile long nextPairingPoll;

  private JSONObject pairingRequest() {
    return vault.object(TABLET_PAIRING);
  }

  private void showPairingStatus(String status, String error) throws JSONException {
    JSONObject current = new JSONObject(tabletPairing.toString());
    current.put("status", status).put("error", error);
    tabletPairing = current;
  }

  synchronized void openTabletPairing(boolean replace, boolean renew) {
    if (busy || updateBlocksPlayer() || (hasStoredEnrollment() && !replace)
        || !pairingRequested.compareAndSet(false, true)) return;
    heartbeat.execute(() -> {
      synchronized (enrollmentState) {
        try {
          JSONObject request = pairingRequest();
          if (busy) return;
          if (renew && !java.util.Set.of("expired", "declined", "unavailable", "assignment")
              .contains(tabletPairing.optString("status"))) return;
          if (request.length() == 0 || renew) {
            byte[] secret = new byte[32];
            new java.security.SecureRandom().nextBytes(secret);
            int flags = android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP;
            request = new JSONObject().put("id", java.util.UUID.randomUUID().toString())
                .put("claim", android.util.Base64.encodeToString(secret, flags)).put("replace", replace);
            vault.put(TABLET_PAIRING, request.toString());
            tabletPairing = new JSONObject();
          }
          nextPairingPoll = android.os.SystemClock.elapsedRealtime() + 5_000;
          // Claim first so a lost response can be recovered even after expiry.
          JSONObject result = api.call("/api/tablet/pairing", request.put("action", "claim"));
          String status = result.optString("status");
          if ("enrolled".equals(status)) {
            finishEnrollment();
            showPairingStatus("enrolled", "");
            refresh();
            return;
          }
          if (!"unavailable".equals(status) && !"pending".equals(status)) {
            showPairingStatus(status, result.optString("error"));
            return;
          }
          if ("unavailable".equals(status) && !tabletPairing.optString("pin").isEmpty()) {
            showPairingStatus("unavailable", "");
            return;
          }
          if ("pending".equals(status) && !tabletPairing.optString("pin").isEmpty()) {
            showPairingStatus("pending", "");
            return;
          }
          result = api.call("/api/tablet/pairing", request.put("action", "create"));
          String pin = result.optString("pin");
          JSONObject presentation = new JSONObject().put("status", result.optString("status"));
          if (pin.matches("[0-9]{6}")) {
            String link = result.getString("link");
            if (!(BuildConfig.APP_ORIGIN + "/admin/pair-device?request=" + request.getString("id")).equals(link))
              throw new IllegalStateException("Pairing returned an unexpected address.");
            presentation.put("pin", pin).put("qr", pairingQr(link)).put("expiresAt", result.optString("expiresAt"));
          }
          tabletPairing = presentation;
          nextPairingPoll = android.os.SystemClock.elapsedRealtime() + 5_000;
        } catch (Exception unavailable) {
          try { showPairingStatus(ConnectionNotice.message(context, api.serverReachable).startsWith("No internet") ? "offline" : "server-unavailable",
              "The pairing request is saved. Check the connection and retry."); }
          catch (JSONException ignored) { }
        } finally {
          pairingRequested.set(false);
        }
      }
    });
  }

  void pollTabletPairing() {
    JSONObject request = pairingRequest();
    String state = tabletPairing.optString("status");
    if (!visible || request.length() == 0
        || !java.util.Set.of("pending", "approved", "offline", "server-unavailable").contains(state)
        || android.os.SystemClock.elapsedRealtime() < nextPairingPoll) return;
    nextPairingPoll = android.os.SystemClock.elapsedRealtime() + 5_000;
    openTabletPairing(request.optBoolean("replace"), false);
  }

  private static String pairingQr(String link) throws Exception {
    var matrix = new com.google.zxing.qrcode.QRCodeWriter().encode(
        link, com.google.zxing.BarcodeFormat.QR_CODE, 288, 288);
    android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(288, 288, android.graphics.Bitmap.Config.ARGB_8888);
    try (java.io.ByteArrayOutputStream image = new java.io.ByteArrayOutputStream()) {
      int[] pixels = new int[288 * 288];
      for (int y = 0; y < 288; y++)
        for (int x = 0; x < 288; x++) pixels[y * 288 + x] = matrix.get(x, y) ? 0xff000000 : 0xffffffff;
      bitmap.setPixels(pixels, 0, 288, 0, 0, 288, 288);
      if (!bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, image))
        throw new java.io.IOException("Could not show the pairing QR.");
      return android.util.Base64.encodeToString(image.toByteArray(), android.util.Base64.NO_WRAP);
    } finally {
      bitmap.recycle();
    }
  }
  private void finishEnrollment() throws Exception {
    try { emailHistory.remove(""); }
    catch (Exception ignored) { /* The new credential already isolates the previous history. */ }
    vault.put("device-id", "");
    server = new JSONObject();
    clearCameraCache();
    vault.put(TABLET_PAIRING, "");
    tabletPairing = new JSONObject();
    vault.put("pending-enrollment", "");
    error = "";
    message = "Tablet enrolled. Retrieving its assigned camera settings…";
  }

  void enroll(String code, boolean replace) {
    String enteredCode = code.trim();
    if (!EnrollmentLink.pairingCode(enteredCode) && !enteredCode.matches("[A-Za-z0-9_-]{24}")) {
      error = "Enter the full pairing code from Admin.";
      return;
    }
    try { submitEnrollment(new JSONObject().put("code", enteredCode).put("replace", replace)); }
    catch (JSONException invalid) { error = "Could not read the enrollment code."; }
  }

  void enrollQr(String invite, String pin, boolean replace) {
    if (!invite.matches("[A-Za-z0-9_-]{24}") || !pin.matches("[0-9]{6}")) {
      error = "Scan the enrollment QR and enter the six-digit PIN from Admin.";
      return;
    }
    try { submitEnrollment(new JSONObject().put("invite", invite).put("pin", pin).put("replace", replace)); }
    catch (JSONException invalid) { error = "Could not read the enrollment invitation."; }
  }

  private void submitEnrollment(JSONObject requested) {
    if(hasStoredEnrollment() && !requested.optBoolean("replace")) {
      error="This app is already registered. Use Re-enroll device only when intentionally replacing its registration.";
      return;
    }
    if (!claim()) return;
    work.execute(
        () -> {
          try {
            synchronized (enrollmentState) {
              JSONObject attempt = vault.object("pending-enrollment");
              if (!requested.optString("code").equals(attempt.optString("code"))
                  || !requested.optString("invite").equals(attempt.optString("invite"))
                  || !requested.optString("pin").equals(attempt.optString("pin"))
                  || requested.optBoolean("replace") != attempt.optBoolean("replace")) {
                byte[] secret = new byte[32];
                new java.security.SecureRandom().nextBytes(secret);
                int encoding = android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP;
                attempt = requested.put("attempt", android.util.Base64.encodeToString(secret, encoding));
                vault.put("pending-enrollment", attempt.toString());
              }
              nextEnrollmentRecoveryNanos = 0;
              try { api.call("/api/tablet/enroll", attempt); }
              catch (Api.RequestFailure failure) {
                // These responses reject the request before issuing a device credential.
                if (failure.httpStatus == 400 || failure.httpStatus == 403
                    || failure.httpStatus == 409 || failure.httpStatus == 422) {
                  vault.put("pending-enrollment", "");
                }
                if (failure.httpStatus == 400 && EnrollmentLink.pairingCode(attempt.optString("code"))
                    && "Enter the full enrollment code from your administrator.".equals(failure.getMessage()))
                  throw new Exception("This server rejected the 12-character code. Use an invitation from the same Admin site as this app.");
                throw failure;
              }
              finishEnrollment();
            }
            refresh();
          } catch (Exception e) {
            error = e.getMessage();
          } finally {
            busy = false;
            if (server.optBoolean("enabled")) {
              if (cameraMode().isEmpty())
                message = "Open Device setup and choose this tablet’s camera.";
              else if (usesDeviceCamera() && !DeviceCameraRecorder.hasPermissions(context))
                message = "Open Device setup and allow camera and microphone access.";
              else
                message =
                    "Open Device setup and test the assigned camera before recording.";
            }
          }
        });
  }

  boolean cameraReady(JSONObject d) {
    return cameraCheckedThisLaunch && DeviceCameraRecorder.hasPermissions(context)
        && confirmedCameraConnection.equals(UvcCameraRecorder.connectionKey(context)) && d != null
        && "android_rtsp".equals(d.optString("recorder_mode"))
        && "android-camera-v1".equals(d.optString("video_device"))
        && !d.isNull("tested_at")
        && !vault.get("camera").isEmpty()
        && vault.get("camera-revision").equals(d.optString("config_revision"))
        && vault.get("camera-revision").equals(d.optString("tested_revision"));
  }

  void syncCamera() {
    requireCameraCheck();
    if (!usesDeviceCamera()) {
      error = "";
      message =
          server.optBoolean("enabled")
              ? "This tablet is enrolled. Open Device setup and choose its camera."
              : hasStoredEnrollment()
                  ? "Enrollment is saved. Check the connection and refresh this device before testing the camera."
                  : "Open Device setup and enter an enrollment code before testing the camera.";
      phase = "idle";
      return;
    }
    if (!visible || !claim()) return;
    clearCameraTestReview();
    try {
      startService(true, false);
    } catch (Exception e) {
      busy = false;
      error = "Open the app and retry the camera test.";
      return;
    }
    phase = "testing";
    message = "Testing this Android device’s USB or built-in camera…";
    work.execute(
        () -> {
          File test = cameraTestFile();
          String revision = "";
          boolean readyForReview = false;
          try {
            updateServer(api.call("/api/tablet", null));
            JSONObject session = server.optJSONObject("session");
            if (session != null && activeCaptureStatus(session.optString("status")))
              throw new Exception("Finish or recover the current match before testing.");
            JSONObject config =
                api.call("/api/tablet/camera", new JSONObject().put("action", "configuration"));
            revision = config.getString("revision");
            attemptedRevision = revision;
            JSONObject camera = config.getJSONObject("camera");
            final String connection = UvcCameraRecorder.connectionKey(context);
            final long connectionGeneration = cameraConnectionGeneration;
            max60Pixels=Long.MAX_VALUE;
            maxFallbackPixels=Long.MAX_VALUE;
            captureModeKey="auto".equals(selectedModeKey)?"":selectedModeKey;
            recordingAudioInput = "";
            message = "Testing this Android device’s USB or built-in camera…";
            vault.put("camera", "");
            vault.put("camera-revision", "");
            try {
              long capturedMillis = 0;
              File bestClip=new File(cameraTestDirectory(),"best-mode.mp4");
              RecordingProfile bestMode=null;
              long bestDuration=0;
              double bestRate=0;
              for (int attempt = 0; attempt < ("auto".equals(selectedModeKey)?2:1); attempt++) {
                try {
                capturedMillis = captureCamera(
                    camera,
                    test,
                    3,
                    0,
                    new CameraCapture.Listener() {
                      public void ready() {}

                      public void countdown(int value) {}

                      public void started() {}

                      public void camera(String label) {}
                      public void modes(java.util.List<RecordingProfile> modes) throws Exception { reportRecordingModes(modes); }

                      public void audio(String label) { recordingAudioInput = label; }
                      public void profile(int width, int height, int fps, int bitrate) {
                        recordingProfile = new RecordingProfile(width, height, fps, 0).label();
                        recordingBitrate = bitrate;
                        recordingWidth=width; recordingHeight=height; recordingFps=fps;
                      }

                      public void frame(int seconds) {
                        elapsed = seconds;
                      }
                    });
                } catch(Exception unavailable) {
                  if(bestMode!=null&&unavailable.getMessage()!=null&&unavailable.getMessage().startsWith("No compatible recording mode"))break;
                  throw unavailable;
                }
                cameraMeasuredFps = RecordedVideo.measuredFrameRate(test);
                Log.i("DinkVisionCamera", "Measured camera fps=" + cameraMeasuredFps + " target=" + recordingFps);
                long playableMillis=RecordedVideo.validate(test,capturedMillis,expectsAudio(camera));
                boolean completeTest=playableMillis>=3000
                    && (!expectsAudio(camera)||RecordedVideo.audioDurationMillis(test)>=3000);
                RecordingProfile candidate=new RecordingProfile(recordingWidth,recordingHeight,recordingFps,0);
                boolean eligible=completeTest && (!"auto".equals(selectedModeKey)||RecordingProfile.sustains60(cameraMeasuredFps)
                    || (Math.max(candidate.width,candidate.height)<=1920 && Math.min(candidate.width,candidate.height)<=1080));
                if(eligible && (bestMode==null || RecordingProfile.deliveredTier(cameraMeasuredFps)>RecordingProfile.deliveredTier(bestRate)
                    || (RecordingProfile.deliveredTier(cameraMeasuredFps)==RecordingProfile.deliveredTier(bestRate)
                        && (long)candidate.width*candidate.height>(long)bestMode.width*bestMode.height))) {
                  bestMode=candidate;bestDuration=capturedMillis;bestRate=cameraMeasuredFps;
                  java.nio.file.Files.copy(test.toPath(),bestClip.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
                if(!"auto".equals(selectedModeKey)||(completeTest&&RecordingProfile.sustains60(cameraMeasuredFps)))break;
                if(recordingFps==60)max60Pixels=0;
                else maxFallbackPixels=(long)recordingWidth*recordingHeight-1;
                message = "Comparing a supported fallback camera mode…";
              }
              if(bestMode==null)throw new Exception("No usable camera test was recorded.");
              java.nio.file.Files.move(bestClip.toPath(),test.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);
              capturedMillis=bestDuration;cameraMeasuredFps=bestRate;recordingBitrate=bestMode.bitrate();
              captureModeKey=bestMode.key();max60Pixels=Long.MAX_VALUE;maxFallbackPixels=Long.MAX_VALUE;
              recordingProfile=bestMode.label()+String.format(java.util.Locale.ROOT," · test %.1f fps",bestRate);
              LiveLogoEvidence.requireVerified(test);
              if (RecordedVideo.validate(test, capturedMillis, expectsAudio(camera)) < 3000
                  || (expectsAudio(camera) && RecordedVideo.audioDurationMillis(test) < 3000))
                throw new Exception("Camera check saved less than three seconds. Reconnect the camera and retry.");
            } catch (Exception e) {
              String reason = e.getMessage();
              Log.e("DinkVisionCamera", "Camera test failed", e);
              if (!DeviceCameraRecorder.hasPermissions(context))
                throw new Exception(
                    "Camera and microphone access is not available. Open Android Settings, allow both permissions, then retry.",
                    e);
              throw new Exception(
                  reason == null || reason.trim().isEmpty()
                      ? "The camera test failed without an error message. Reconnect the USB camera and retry."
                      : reason.trim(),
                  e);
            }
            cameraTestRevision = revision;
            if (connectionGeneration != cameraConnectionGeneration || !connection.equals(UvcCameraRecorder.connectionKey(context)))
              throw new Exception("Camera connection changed. Record another test.");
            cameraTestConnection = connection;
            cameraTestGeneration = connectionGeneration;
            cameraTestCamera = camera.toString();
            cameraTestHasAudio = expectsAudio(camera);
            cameraTestToken = revision + "-" + System.currentTimeMillis();
            cameraTestMode = selectedModeKey;
            cameraTestReady = true;
            readyForReview = true;
            message =
                cameraTestHasAudio
                    ? "Test clip ready. Play it with the volume on, then confirm that video and audio are clear."
                    : "Test clip ready. Play it, then confirm that the video is clear.";
          } catch (Exception e) {
            String problem = e.getMessage() == null ? "" : e.getMessage();
            boolean setupRequired =
                problem.contains("Open Device setup and choose")
                    || problem.contains("Choose the USB or built-in Android camera");
            error = setupRequired ? "" : problem;
            message =
                setupRequired
                    ? "Open Device setup and choose this tablet’s camera."
                    : "Camera setup needs attention.";
            if (!revision.isEmpty()) clearCameraCache();
            if (!revision.isEmpty())
              try {
                api.call(
                    "/api/tablet/camera",
                    new JSONObject()
                        .put("action", "tested")
                        .put("revision", revision)
                        .put("passed", false));
              } catch (Exception ignored) {
              }
          } finally {
            if (!readyForReview) clearCameraTestReview();
            new File(cameraTestDirectory(),"best-mode.mp4").delete();
            phase = readyForReview ? "review" : "error";
            elapsed = 0;
            finishWork();
          }
        });
  }

  boolean canConfirmCameraTest() {
    return cameraTestReady && !cameraTestMode.isEmpty() && cameraTestMode.equals(selectedModeKey)
        && cameraTestGeneration == cameraConnectionGeneration
        && cameraTestConnection.equals(UvcCameraRecorder.connectionKey(context));
  }

  void confirmCameraTestRequest(String payload) {
    try {
      JSONObject request = new JSONObject(payload);
      if (!selectedModeKey.equals(request.optString("mode")) || cameraTestToken.isEmpty()
          || !cameraTestToken.equals(request.optString("token"))) {
        error = "The camera test changed. Review the current test before confirming.";
        return;
      }
      confirmCameraTest(true, false);
    } catch (Exception invalid) {
      error = "Review the current camera test before confirming.";
    }
  }

  void confirmCameraTest(boolean accepted, boolean retry) {
    if (accepted && !canConfirmCameraTest()) {
      error = "Camera or recording mode changed. Record another test.";
      return;
    }
    if (!cameraTestReady || cameraTestRevision.isEmpty() || cameraTestCamera.isEmpty()) {
      error = "The saved test clip is unavailable. Record another three-second test clip.";
      phase = "error";
      return;
    }
    if (!visible || !claim()) return;
    phase = "confirming-test";
    message = accepted ? "Saving your camera confirmation…" : "Preparing another camera test…";
    final String revision = cameraTestRevision;
    final String camera = cameraTestCamera;
    final String connection = cameraTestConnection;
    final long connectionGeneration = cameraTestGeneration;
    if (retry) {
      work.execute(
          () -> {
            try {
              api.call(
                  "/api/tablet/camera",
                  new JSONObject()
                      .put("action", "tested")
                      .put("revision", revision)
                      .put("passed", false));
            } catch (Exception e) {
              // The old revision may already be invalid. A fresh configuration
              // and capture are still the correct next steps.
              Log.w("DinkVisionCamera", "Could not clear prior camera test before retry", e);
            }
            clearCameraCache();
            clearCameraTestReview();
            attemptedRevision = "";
            error = "";
            phase = "idle";
            refresh();
            busy = false;
            if (visible) syncCamera();
            else RecorderService.stopWhenIdle();
          });
      return;
    }
    work.execute(
        () -> {
          boolean updated = false;
          try {
            if (accepted && (connectionGeneration != cameraConnectionGeneration || !connection.equals(UvcCameraRecorder.connectionKey(context))))
              throw new Exception("Camera connection changed. Record another test.");
            api.call(
                "/api/tablet/camera",
                new JSONObject()
                    .put("action", "tested")
                    .put("revision", revision)
                    .put("passed", accepted));
            if (accepted) {
              if (connectionGeneration != cameraConnectionGeneration)
                throw new Exception("Camera connection changed. Record another test.");
              vault.put("camera", camera);
              vault.put("camera-revision", revision);
              confirmedCameraConnection = connection;
              cameraCheckedThisLaunch = true;
              attemptedRevision = "";
              message =
                  cameraTestHasAudio
                      ? "Video and audio confirmed. This tablet is ready for player mode."
                      : "Video confirmed. This tablet is ready in video-only mode.";
            } else {
              clearCameraCache();
              message = "Record another three-second test clip.";
            }
            error = "";
            updated = true;
          } catch (Exception e) {
            error = e.getMessage();
            message = "The camera test confirmation could not be saved.";
          } finally {
            if (updated) clearCameraTestReview();
            phase = updated ? "idle" : "review";
            busy = false;
            RecorderService.stopWhenIdle();
            refresh();
          }
        });
  }

  private JSONArray recipientEmails(JSONArray input) throws Exception {
    JSONArray result = new JSONArray();
    HashSet<String> unique = new HashSet<>();
    if (input.length() < 1 || input.length() > 4)
      throw new Exception("Enter at least one email address on either team.");
    for (int i = 0; i < input.length(); i++) {
      String value = input.optString(i).trim().toLowerCase(Locale.ROOT);
      if (value.length() > 254
          || !value.matches("^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$")
          || value.matches("(?i).*@example\\.(com|net|org)$")
          || !unique.add(value))
        throw new Exception("Enter valid, different email addresses.");
      result.put(value);
    }
    return result;
  }

  synchronized void start(String recipientJson, long bridgeReceivedNanos) {
    if (!claim()) {
      noteRepeatedStart();
      return;
    }
    if (!visible) { busy = false; return; }
    startHasRecoverableFootage = false;
    if (updateBlocksPlayer()) {
      error = "Check and install the required Android update first.";
      busy = false;
      return;
    }
    final JSONArray recipients;
    final JSONArray consent;
    final int webDelayMs;
    try {
      JSONObject request = recipientJson.startsWith("{") ? new JSONObject(recipientJson) : null;
      recipients = recipientEmails(request == null ? new JSONArray(recipientJson) : request.getJSONArray("emails"));
      consent = request == null ? null : request.optJSONArray("remember");
      webDelayMs = request == null ? 0 : request.optInt("tapDelayMs", 0);
    } catch (Exception e) {
      phase = "error";
      error = e.getMessage();
      busy = false;
      return;
    }
    final RecorderDiagnostics.Trace trace = diagnostics.beginCapture(vault.get("device-id"), queuedWorkCount(), bridgeReceivedNanos, webDelayMs);
    final String email = recipients.optString(0);
    JSONObject configured = server.optJSONObject("device");
    if (!cameraReady(configured)) {
      phase = "error";
      message = "Camera setup needs attention.";
      if (usesDeviceCamera())
        error =
            "The Android camera test has not passed. Open Device setup, allow camera and microphone access, then test again.";
      else
        error =
            "Open Device setup, choose a supported camera mode, and run the camera test.";
      trace.finish(new CameraCapture.StartFailure(error));
      busy = false;
      return;
    }
    captureTrace = trace;
    trace.accepted();
    captureAttempt = UUID.randomUUID().toString();
    phase = "connecting";
    message = "Preparing your recording…";
    try {
      startService(true, false);
    } catch (Exception e) {
      trace.finish(e);
      phase = "error";
      error = "Allow camera and microphone permissions, then try again.";
      captureAttempt = "";
      captureTrace = null;
      busy = false;
      return;
    }
    work.execute(
        () -> {
          String sid = "";
          File file = null;
          try {
            if (stop) throw new CameraCapture.StartCancelled();
            trace.stage("release_check");
            refreshRelease();
            if (updateBlocksPlayer()) throw new Exception("Install the required Android update before recording.");
            JSONObject camera = vault.object("camera");
            if (camera.length() == 0) throw new Exception("Configure and test the camera first.");
            trace.stage("reconcile");
            updateServer(api.call("/api/tablet", null));
            releaseBlockingCapture();
            JSONObject device = server.optJSONObject("device");
            if (device == null) throw new Exception("Enroll this tablet first.");
            if (!cameraReady(device))
              throw new Exception("Camera settings changed. Open Device setup and retry the test.");
            int seconds = server.optInt("maxSeconds", 900);
            if (seconds < 1 || seconds > 7200) throw new Exception("Invalid recording limit.");
            File dir = new File(context.getFilesDir(), "recordings");
            dir.mkdirs();
            if (dir.getUsableSpace() < requiredRecordingBytes(seconds, recordingBitrate))
              throw new Exception("Not enough tablet storage for this match.");
            if (stop) throw new CameraCapture.StartCancelled();
            JSONObject attempt = vault.object("start-request");
            if (!recipients.toString().equals(attempt.optJSONArray("emails") == null ? "" : attempt.optJSONArray("emails").toString()))
              attempt =
                  new JSONObject().put("email", email).put("emails", recipients).put("key", UUID.randomUUID().toString());
            vault.put("start-request", attempt.toString());
            String historyEnrollment = consent == null ? "" : emailHistory.enrollment();
            trace.stage("reserve");
            sid =
                api.tablet(
                        "start",
                        new JSONObject(attempt.toString())
                            .put("revision", vault.get("camera-revision")))
                    .getString("id");
            UUID.fromString(sid);
            trace.session(sid);
            file = new File(dir, sid + ".mp4");
            if (file.exists())
              throw new Exception(
                  "Saved footage already exists. Recover it before recording again.");
            saveQueueItem(
                new JSONObject()
                    .put("id", sid)
                    .put("jobId", sid)
                    .put("device", device.getString("id"))
                    .put("court", device.optString("court_id"))
                    .put("recipients", recipients)
                    .put("audioExpected", expectsAudio(camera))
                    .put("createdAt", System.currentTimeMillis())
                    .put("status", "recording")
                    .put("liveLogoRequired", true)
                    .put("progress", 0)
                    .put("retryCount", 0)
                    .put("localAvailable", true));
            activeSession = sid;
            uploadPercent = -1;
            vault.put("start-request", "");
            try { emailHistory.remember(historyEnrollment, recipients, consent); }
            catch (Exception ignored) { /* Optional local history must never block recording. */ }
            final String id = sid;
            message = "Preparing camera…";
            trace.stage("camera_prepare");
            long capturedMillis;
            try {
              if (stop) throw new CameraCapture.StartCancelled();
              message = "Preparing the camera and waiting for video…";
              capturedMillis =
                  captureCamera(
                  camera,
                  file,
                  seconds,
                  3,
                  new CameraCapture.Listener() {
                    public void ready() {
                      trace.stage("countdown");
                    }

                    public void preparation(String stage) { trace.stage(stage); }
                    @Override public void countdown(int value) {
                      synchronized (Engine.this) {
                        if (stop) return;
                        countdown = value;
                        if (value > 0) {
                          phase = "countdown";
                          message = "Recording starts in " + value + "…";
                        }
                      }
                    }

                    public void started() throws Exception {
                      synchronized (Engine.this) {
                        if (stop) throw new CameraCapture.StartCancelled();
                        countdown = 0;
                        recordingStartedNanos = System.nanoTime();
                        elapsed = 0;
                        phase = "recording";
                        message = "Recording your match";
                      }
                      trace.stage("capture");
                      heartbeat.execute(
                          () -> {
                            try {
                              api.tablet("started", new JSONObject().put("id", id));
                            } catch (Exception ignored) {
                            }
                          });
                    }

                    public void frame(int s) {
                      elapsed = s;
                    }

                    public void audio(String label) {
                      recordingAudioInput = label;
                      if ("recording".equals(phase)) message = "Recording your match · " + label;
                    }

                    public void profile(int width, int height, int fps, int bitrate) throws Exception {
                      recordingProfile = new RecordingProfile(width, height, fps, 0).label();
                      if (cameraMeasuredFps > 0) recordingProfile += String.format(java.util.Locale.ROOT, " · test %.1f fps", cameraMeasuredFps);
                      recordingBitrate = bitrate;
                      if (dir.getUsableSpace() < requiredRecordingBytes(seconds, bitrate))
                        throw new Exception("Not enough device storage for the selected camera quality.");
                    }

                    public void finalizing() {
                      try {
                        JSONObject item = queueItem(id);
                        if ("recording".equals(item.optString("status"))) {
                          item.put("captureEndedNormally", true);
                          saveQueueItem(item);
                        }
                      } catch (Exception ignored) { }
                      trace.stage("finalize");
                      phase = "finalizing";
                      message = "Finalizing the complete video… Keep this app open.";
                    }

                    public void interrupted(CameraCapture.Interruption interruption) {
                      try { noteCaptureInterruption(id, interruption); }
                      catch (Exception ignored) { }
                      phase = "finalizing";
                      message = "Recording interrupted. Saving available footage…";
                    }

                    public boolean validateSavedMediaInBackground() { return true; }
                  });
            } catch (Exception e) {
              trace.finish(e);
              if (e instanceof CameraCapture.StartCancelled)
                throw new Exception(error.isEmpty() ? e.getMessage() : error, e);
              if (recordingStartedNanos > 0 && !queueItem(sid).optBoolean("captureEndedNormally")) {
                CameraCapture.Interruption interruption = CameraCapture.Interruption.observed(e);
                noteCaptureInterruption(sid, interruption);
                if (interruption.code == CameraCapture.InterruptionCode.CAMERA_DISCONNECTED
                    || interruption.code == CameraCapture.InterruptionCode.CAMERA_FAILURE) requireCameraCheck();
              }
              if (queueItem(sid).has("captureInterruptionCode") && LiveLogoEvidence.hasSeal(file)) {
                // The stopped media can be shorter than the wall clock. Validate
                // the tracks and use their actual duration on the upload worker.
                capturedMillis = -1;
              } else {
                String detail = e.getMessage();
                String reason = e instanceof RecordingAccuracy.Failure
                    || e instanceof CameraCapture.StartFailure || e instanceof CameraCapture.Interruption
                    || (detail != null && detail.startsWith("The USB camera"))
                        ? detail : "Could not save a complete recording.";
                boolean savedFootage = file.isFile() && file.length() >= 1024;
                throw new Exception(reason + (savedFootage
                    ? " The original is in Saved videos." : " Reconnect the camera and try again."), e);
              }
            }
            phase = "finalizing";
            message = "Saving the complete video…";
            JSONObject queued = saveFinalizedCapture(sid, file, capturedMillis);
            trace.finish(null);
            latestSavedSession = sid;
            JSONObject queueReport = new JSONObject(queued.toString());
            heartbeat.execute(
                () -> {
                  try {
                    releaseCapturedRecording(queueReport);
                    // Make the locally safe video visible to venue staff without
                    // delaying the tablet's return to the welcome screen.
                    reportQueueItem(queueReport);
                  } catch (Exception ignored) {
                    // The durable local queue remains authoritative while offline.
                  }
                });
            phase = "complete";
            message = queued.has("captureInterruptionCode")
                ? "Recording interrupted. Saved footage is being checked."
                : "Video saved. It will be checked in the background. You can start another match.";
          } catch (Exception e) {
            trace.finish(e);
            startHasRecoverableFootage = file != null && file.isFile() && file.length() >= 1024;
            error = e.getMessage();
            phase = "error";
            boolean failureJournaled = false;
            if (!sid.isEmpty())
              try {
                JSONObject failed = queueItem(sid);
                if (failed.length() > 0) {
                  failed
                      .put("status", "failed")
                      .put("lastError", error)
                      .put("bytes", file != null && file.isFile() ? file.length() : 0)
                      .put("localAvailable", file != null && file.isFile() && file.length() > 0);
                  if (failed.has("captureInterruptionCode"))
                    failed.put("validationFailed", true).put("validationPending", false)
                        .put("failureReportPending", true);
                  saveQueueItem(failed);
                  failureJournaled = true;
                }
              } catch (Exception ignored) {
              }
            if (failureJournaled) {
              String failedSession = sid;
              try {
                heartbeat.execute(() -> {
                  try { api.tablet("failed", captureEventFields(queueItem(failedSession))); }
                  catch (Exception ignored) { /* Heartbeat or the next start can reconcile the saved failure. */ }
                });
              } catch (RejectedExecutionException ignored) { }
            } else if (!sid.isEmpty())
              try {
                api.tablet("failed", new JSONObject().put("id", sid));
              } catch (Exception ignored) {
              }
          } finally {
            countdown = 0;
            recordingStartedNanos = 0;
            activeSession = "";
            captureAttempt = "";
            captureTrace = null;
            finishCaptureWork();
            // The foreground capture is free as soon as the original file is
            // durable. Logo processing and upload continue independently.
            kickUploads();
          }
        });
  }

  private JSONObject captureEventFields(JSONObject item) throws JSONException {
    JSONObject fields = new JSONObject().put("id", item.getString("id"));
    if (item.has("captureInterruptionCode")) {
      fields.put("capture_interruption_code", item.getString("captureInterruptionCode"));
      if (item.optLong("captureInterruptedAt") > 0)
        fields.put("capture_interrupted_at", item.getLong("captureInterruptedAt"));
    }
    return fields;
  }

  void noteCaptureInterruption(String sid, CameraCapture.Interruption interruption) throws Exception {
    JSONObject item = queueItem(sid);
    if (!"recording".equals(item.optString("status")) || item.has("captureInterruptionCode")) return;
    item.put("captureInterruptionCode", interruption.code.value)
        .put("captureInterruptedAt", interruption.occurredAt);
    saveQueueItem(item);
  }

  JSONObject saveFinalizedCapture(String sid, File file, long capturedMillis) throws Exception {
    // The camera has closed and the encoder has synced its live-watermark seal.
    // A footer check is enough to journal the handoff. The worker verifies the
    // exact bytes and validates the tracks before preview or upload.
    if (file.length() < 1024 || !LiveLogoEvidence.hasSeal(file))
      throw new RecordingAccuracy.Failure("Could not finalize the saved video. Available footage was kept on this device.");
    JSONObject item = queueItem(sid);
    if (!"recording".equals(item.optString("status")))
      throw new IllegalStateException("The local recording session changed before finalization.");
    item.put("captureDurationMs", capturedMillis)
        .put("bytes", file.length())
        .put("validationPending", true)
        .put("branded", false)
        .put("brandingState", "complete")
        .put("brandingProgress", 100)
        .put("captureReleased", false)
        .put("status", "saved_locally")
        .put("lastError", "")
        .put("nextRetryAt", 0);
    saveQueueItem(item);
    return item;
  }

  void recover() {
    kickUploads();
  }

  void noteRepeatedStart() {
    RecorderDiagnostics.Trace trace = captureTrace;
    if (trace != null) trace.repeatedStart();
  }

  void noteRepeatedStop(String attempt) {
    RecorderDiagnostics.Trace trace = captureTrace;
    if (trace != null && !attempt.isEmpty() && attempt.equals(captureAttempt))
      trace.repeatedStop(RecorderDiagnostics.ActionSource.PLAYER);
  }

  synchronized void leavePlayerWorkflow() {
    visible = false;
    if ("connecting".equals(phase) || "countdown".equals(phase)) requestStop(captureAttempt);
  }

  void requestStop(String attempt) {
    requestStop(attempt, RecorderDiagnostics.ActionSource.PLAYER);
  }

  synchronized void requestStop(String attempt, RecorderDiagnostics.ActionSource source) {
    if (!busy || attempt.isEmpty() || !attempt.equals(captureAttempt)) return;
    RecorderDiagnostics.Trace trace = captureTrace;
    if (stop || "finalizing".equals(phase)) {
      if (trace != null) trace.repeatedStop(source);
      return;
    }
    if ("error".equals(phase) || "complete".equals(phase)) return;
    if (trace != null) trace.stopRequested(source);
    boolean wasRecording = "recording".equals(phase);
    stop = true;
    countdown = 0;
    String sid = activeSession;
    phase = "finalizing";
    message = wasRecording ? "Stopping recording…" : "Cancelling recording start…";
    if (!wasRecording || sid.isEmpty()) return;
    try {
      heartbeat.execute(() -> {
        try { api.tablet("stopped", new JSONObject().put("id", sid)); }
        catch (Exception ignored) { }
      });
    } catch (RejectedExecutionException ignored) { }
  }

  void retryUpload(String sid) {
    try {
      localVideoSession = sid;
      UUID.fromString(sid);
      synchronized (vault) {
        JSONObject item = queueItem(sid);
        if (item.length() == 0
            || !item.optBoolean("localAvailable", true)
            || !belongsToCurrentDevice(item)) return;
        if (interruptedNeedsInspection(item)) {
          localVideoError = "The interrupted video needs inspection. Save the original to this device.";
          return;
        }
        String previousStatus=item.optString("status");
        if (!java.util.Arrays.asList("failed","retrying").contains(previousStatus)) {
          localVideoError = "This video is already queued or is not eligible for another upload.";
          return;
        }
        if (sid.equals(uploadWorkerSession) || reportingUploadFailures.contains(sid)) {
          localVideoError="An upload attempt is already running. This video remains scheduled.";
          return;
        }
        localPlaybackFile(sid);
        item
            .put("status", "pending")
            .put("retryCount", "failed".equals(previousStatus) ? 0 : item.optInt("retryCount"))
            .put("serverRetryRequired", true)
            .put("waitingForUploadTurn", false)
            .put("nextQueueCheckAt", 0)
            .put("failureReportPending", false)
            .put("lastError", "")
            .put("nextRetryAt", 0);
        saveQueueItem(item);
      }
      localVideoError = "";
      localVideoMessage = "Retry queued. Processing and upload will resume when this tablet can connect.";
      kickUploads();
    } catch (Exception e) {
      localVideoError = "This saved video could not be retried. Check that its local file is still available.";
    }
  }

  void retryLatestFailedUpload() {
    if (busy) return;
    JSONObject item = latestRecoverableRecording();
    if (item.length() == 0) {
      error = "There is no saved video to recover on this device.";
      return;
    }
    error = "";
    latestSavedSession = item.optString("id");
    phase = "complete";
    message = "Checking the saved video…";
    retryUpload(item.optString("id"));
  }

  private String currentDeviceId() {
    JSONObject device = server.optJSONObject("device");
    String currentDevice = device == null ? vault.get("device-id") : device.optString("id");
    if (server.has("enabled") && !server.optBoolean("enabled")) currentDevice = "";
    return currentDevice;
  }

  private boolean belongsToCurrentDevice(JSONObject item) {
    String currentDevice = currentDeviceId();
    return !currentDevice.isEmpty() && currentDevice.equals(item.optString("device"));
  }

  File localPlaybackFile(String sid) throws Exception {
    UUID.fromString(sid);
    JSONObject item = queueItem(sid);
    if (item.length() == 0
        || !item.optBoolean("localAvailable", true)
        || "recording".equals(item.optString("status"))
        || !belongsToCurrentDevice(item))
      throw new Exception("This saved video is not playable for the currently enrolled device.");
    File file = new File(new File(context.getFilesDir(), "recordings"), sid + ".mp4");
    if (!file.isFile() || file.length() < 1)
      throw new Exception("This saved video is not playable because its local file is missing.");
    return file;
  }

  boolean isPreviewPending(String sid) throws Exception {
    UUID.fromString(sid);
    JSONObject item = queueItem(sid);
    return belongsToCurrentDevice(item) &&
        (item.optBoolean("validationPending") || "processing".equals(item.optString("brandingState")));
  }

  boolean isPreviewInvalid(String sid) {
    return queueItem(sid).optBoolean("validationFailed");
  }

  private static boolean interruptedNeedsInspection(JSONObject item) {
    return item.has("captureInterruptionCode") && item.optBoolean("validationFailed");
  }

  String localVideoName(String sid) throws Exception {
    localPlaybackFile(sid);
    long created = queueItem(sid).optLong("createdAt", System.currentTimeMillis());
    String date = new java.text.SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US)
        .format(new java.util.Date(created));
    JSONArray recipients = queueItem(sid).optJSONArray("recipients");
    String players = recipients == null || recipients.length() == 0 ? "players-not-recorded"
        : recipients.optString(0).replaceAll("[^A-Za-z0-9@._-]", "_");
    if (players.length() > 64) players = players.substring(0, 64);
    if (recipients != null && recipients.length() > 1) players += "-plus-" + (recipients.length() - 1);
    return "DinkVision-" + date + "-" + players + ".mp4";
  }

  private boolean removableLocalItem(JSONObject item) {
    return belongsToCurrentDevice(item) && item.optBoolean("localAvailable", true)
        && java.util.Arrays.asList("local_only", "failed", "uploaded").contains(item.optString("status"))
        && !"processing".equals(item.optString("brandingState"))
        && !item.optString("id").equals(activeSession) && !item.optString("id").equals(uploadWorkerSession);
  }

  private void finishLocalRemoval(JSONObject item) throws Exception {
    if (!removableLocalItem(item)) throw new Exception("Finish processing or uploading this video before removing it.");
    item.put("localAvailable", false).put("localRemovedAt", System.currentTimeMillis())
        .put("removalPending", false).put("presenceReportPending", true).put("nextRetryAt", 0)
        .put("lastError", "App copy removed by user. A separate copy was saved to Gallery / Files.");
    saveQueueItem(item);
  }

  void finishPendingLocalRemovals() throws Exception {
    synchronized (vault) {
      JSONArray items = queue();
      for (int i=0;i<items.length();i++) {
        JSONObject item=items.optJSONObject(i);
        if(item!=null && item.optBoolean("removalPending") && belongsToCurrentDevice(item)) {
          try {
            String sid = item.getString("id");
            UUID.fromString(sid);
            File source = new File(new File(context.getFilesDir(), "recordings"), sid + ".mp4");
            if (source.exists())
              throw new Exception("Removal was interrupted. The original remains saved. Select Remove from app to try again.");
            finishLocalRemoval(item);
          }
          catch(Exception unavailable) {
            // A moved/deleted export must preserve the original and must not
            // prevent other saved videos from reconciling at startup.
            item.put("removalPending",false); saveQueueItem(item);
            localVideoSession=item.optString("id");localVideoError=unavailable.getMessage();
          }
        }
      }
    }
  }

  void removeLocalVideo(String sid) {
    try { UUID.fromString(sid); } catch (Exception invalid) { return; }
    if (!exportWorkerRunning.compareAndSet(false, true)) return;
    localVideoSession = sid;
    exports.execute(() -> {
      try {
        JSONObject receipt = queueItem(sid);
        if (busy || uploadWorkerRunning.get() || !removableLocalItem(receipt))
          throw new Exception("Finish recording, processing and uploading before removing this app copy.");
        File source = localPlaybackFile(sid);
        long bytes = source.length(), modifiedAt = source.lastModified();
        if (bytes != receipt.optLong("exportedBytes") || !LocalVideoExporter.matchesOriginal(
            context.getContentResolver(), receipt.optString("exportedUri"), source))
          throw new Exception("Save a verified device copy first. Use Details to save another copy if needed.");
        synchronized (vault) {
          JSONObject item=queueItem(sid);
          if (busy || uploadWorkerRunning.get() || !removableLocalItem(item))
            throw new Exception("Finish recording, processing and uploading before removing this app copy.");
          if (source.length() != bytes || source.lastModified() != modifiedAt
              || !receipt.optString("exportedUri").equals(item.optString("exportedUri"))
              || receipt.optLong("exportedAt") != item.optLong("exportedAt"))
            throw new Exception("The video or its exported copy changed. Try removing the app copy again.");
          item.put("removalPending",true); saveQueueItem(item);
          if (!source.delete())
            throw new Exception("Could not remove the app copy. It is still saved here.");
          finishLocalRemoval(item);
        }
        localVideoError="";
        localVideoMessage="App copy removed. The exported copy remains in Gallery / Files. Admin will update when connected.";
      } catch (Exception failure) { localVideoError=failure.getMessage(); }
      finally { exportWorkerRunning.set(false); }
    });
  }

  void exportLocalVideo(String sid, android.net.Uri chosen) {
    if (!exportWorkerRunning.compareAndSet(false, true)) return;
    localVideoSession = sid;
    final File source;
    final String name;
    try {
      source = localPlaybackFile(sid);
      name = localVideoName(sid);
      exportingSession = sid;
      exportPercent = 0;
      localVideoError = "";
      localVideoMessage = "Saving a separate copy to this device…";
      startService(false, true);
    } catch (Exception unavailable) {
      exportWorkerRunning.set(false);
      exportingSession = "";
      localVideoError = "Could not start saving. Keep the app open and check the local video.";
      return;
    }
    exports.execute(() -> {
      try (BackgroundTransfers.Ticket ticket = backgroundTransfers.begin()) {
        awaitTransferService(ticket);
        java.util.concurrent.atomic.AtomicLong copiedBytes=new java.util.concurrent.atomic.AtomicLong();
        android.net.Uri uri = LocalVideoExporter.save(context, source, name, chosen,
            percent -> { exportPercent = percent; TransferService.updateExportProgress(percent); },
            destination -> {
              try { vault.put("export-pending-uri", destination.toString()); }
              catch (Exception failure) { throw new IllegalStateException("Could not journal the saved copy.", failure); }
            },copiedBytes::set);
        synchronized (vault) {
          JSONObject latest = queueItem(sid);
          if (latest.length() > 0) {
            latest.put("exportedUri", uri.toString()).put("exportedBytes", copiedBytes.get())
                .put("exportedAt",System.currentTimeMillis()).put("exportReportPending",true);
            upsertQueueLocked(latest,true);
          }
        }
        exportPercent = 100;
        localVideoMessage = chosen == null
            ? "Copy saved to Movies/DinkVision. Find it in Gallery or Files."
            : "Copy saved to your chosen location. The original remains in the app.";
      } catch (Exception failure) {
        localVideoError = backgroundTransfers.isPaused()
            ? "Saving paused. Open Saved videos and choose Save to device again."
            : "Could not save the copy. Check free storage and try again. The original remains in the app.";
      } finally {
        try { vault.put("export-pending-uri", ""); } catch (Exception ignored) { }
        exportWorkerRunning.set(false);
        exportingSession = "";
        TransferService.finishExport();
        TransferService.stopWhenIdle();
      }
    });
  }

  boolean hasPendingUploadWork() {
    JSONArray current = queue();
    for (int index = 0; index < current.length(); index++) {
      JSONObject item = current.optJSONObject(index);
      if (item == null
          || !item.optBoolean("localAvailable", true)
          || interruptedNeedsInspection(item)
          || !belongsToCurrentDevice(item)) continue;
      String status = item.optString("status", "saved_locally");
      if (java.util.Arrays.asList("saved_locally", "pending", "retrying", "uploading")
          .contains(status)) return true;
    }
    return false;
  }

  boolean hasRetryingUpload() {
    JSONArray current = queue();
    for (int index = 0; index < current.length(); index++) {
      JSONObject item = current.optJSONObject(index);
      if (item != null && item.optBoolean("localAvailable", true)
          && belongsToCurrentDevice(item) && "retrying".equals(item.optString("status")))
        return true;
    }
    return false;
  }

  boolean hasWaitingUploadTurn() {
    JSONArray current = queue();
    for (int i = 0; i < current.length(); i++) {
      JSONObject item = current.optJSONObject(i);
      if (item != null && "pending".equals(item.optString("status"))
          && item.optBoolean("waitingForUploadTurn") && belongsToCurrentDevice(item)) return true;
    }
    return false;
  }

  private JSONObject nextUpload() {
    long now = System.currentTimeMillis();
    boolean yieldDuringBackoff = supportsUploadBackoff();
    JSONArray current = queue();
    JSONObject selected = null;
    JSONObject readyUpload = null;
    for (int index = 0; index < current.length(); index++) {
      JSONObject item = current.optJSONObject(index);
      if (item == null
          || !item.optBoolean("localAvailable", true)
          || interruptedNeedsInspection(item)
          || !belongsToCurrentDevice(item)) continue;
      if (reportingUploadFailures.contains(item.optString("id"))) continue;
      String status = item.optString("status", "saved_locally");
      if (!java.util.Arrays.asList("saved_locally", "pending", "retrying").contains(status)) continue;
      long queueWait = item.optLong("nextQueueCheckAt") - now;
      if (yieldDuringBackoff && (item.optLong("nextRetryAt") > now || (queueWait > 0 && queueWait <= 15_000L))) continue;
      // Preserve the original FIFO safeguard against a server without backoff scheduling.
      if (item.optBoolean("branded", false)
          && (readyUpload == null || item.optLong("createdAt") < readyUpload.optLong("createdAt")))
        readyUpload = item;
      if (item.optLong("nextRetryAt", 0) > now) continue;
      if (selected == null || item.optLong("createdAt") < selected.optLong("createdAt"))
        selected = item;
    }
    if (readyUpload != null) {
      if (readyUpload.optLong("nextRetryAt", 0) > now) return null;
      selected = readyUpload;
    }
    if (selected == null) return null;
    try {
      return new JSONObject(selected.toString());
    } catch (Exception ignored) {
      return null;
    }
  }

  private boolean supportsUploadBackoff() {
    JSONObject capabilities = server.optJSONObject("capabilities");
    return capabilities != null && capabilities.optBoolean("uploadBackoffScheduling");
  }

  private JSONObject reserveNextUpload() {
    synchronized (vault) {
      JSONObject item = backgroundTransfers.isPaused() ? null : nextUpload();
      uploadWorkerSession = item == null ? "" : item.optString("id");
      return item;
    }
  }

  private void releaseUploadWorker() {
    synchronized (vault) {
      uploadWorkerSession = "";
      uploadWorkerRunning.set(false);
    }
  }

  void pauseBackgroundTransfers() {
    backgroundTransfers.pause();
    localVideoMessage = BackgroundTransfers.PAUSED;
  }

  void resumeBackgroundTransfers() {
    backgroundTransfers.foregroundEntered();
    if (BackgroundTransfers.PAUSED.equals(localVideoMessage)) localVideoMessage = "";
    try { heartbeat.execute(this::kickUploads); }
    catch (RejectedExecutionException ignored) { }
  }

  private void awaitTransferService(BackgroundTransfers.Ticket ticket) throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
    while (!TransferService.isReady()) {
      ticket.check();
      if (System.nanoTime() >= deadline)
        throw new java.io.IOException("Background transfer service did not start.");
      Thread.sleep(25);
    }
    ticket.check();
  }

  void pauseUploadItem(JSONObject item) throws Exception {
    item.put("status", item.optBoolean("branded") ? "pending" : "saved_locally")
        .put("lastError", BackgroundTransfers.PAUSED);
    if ("processing".equals(item.optString("brandingState")))
      item.put("brandingState", "");
    saveQueueItem(item);
    uploadPercent = -1;
    String session = item.getString("id");
    try {
      heartbeat.execute(() -> {
        try {
          JSONObject current = queueItem(session);
          if (backgroundTransfers.isPaused()
              && BackgroundTransfers.PAUSED.equals(current.optString("lastError")))
            reportQueueItem(current);
        } catch (Exception ignored) { }
      });
    }
    catch (RejectedExecutionException ignored) { }
  }

  void kickUploads() {
    if (backgroundTransfers.isPaused() || !server.optBoolean("enabled")
        || !uploadWorkerRunning.compareAndSet(false, true)) return;
    JSONObject first = reserveNextUpload();
    if (first == null) {
      releaseUploadWorker();
      if (hasPendingUploadWork()) {
        try {
          startService(false, true);
        } catch (Exception ignored) {
          // The next heartbeat retries while uploads remain in the local queue.
        }
      }
      return;
    }
    try {
      startService(false, true);
    } catch (Exception e) {
      releaseUploadWorker();
      return;
    }
    uploads.execute(
        () -> {
          try (BackgroundTransfers.Ticket ticket = backgroundTransfers.begin()) {
            try { awaitTransferService(ticket); }
            catch (Exception unavailable) {
              if (!ticket.cancelled()) pauseBackgroundTransfers();
              return;
            }
            JSONObject item = first;
            upload(item, ticket);
            while (!ticket.cancelled() && (item = reserveNextUpload()) != null) upload(item, ticket);
          } catch (java.io.InterruptedIOException paused) {
            // The durable pause already owns this transition.
          } finally {
            releaseUploadWorker();
            TransferService.stopWhenIdle();
          }
        });
  }

  private void deferUploadTurn(JSONObject item, long delayMs) throws Exception {
    item.put("status", "pending")
        .put("waitingForUploadTurn", true)
        .put("nextQueueCheckAt", System.currentTimeMillis() + delayMs)
        .put("nextRetryAt", 0)
        .put("serverRetryRequired", false)
        .put("lastError", "");
    saveQueueItem(item);
    uploadPercent = -1;
    TransferService.updateUploadProgress(-1);
  }

  private boolean stillWaitingForUploadTurn(JSONObject item) throws Exception {
    if (!item.optBoolean("waitingForUploadTurn")) return false;
    JSONObject response;
    try {
      response = api.tablet("upload-turn", new JSONObject().put("id", item.getString("id")));
    } catch (Exception unavailable) {
      // A status probe did not start a transfer and must not use a retry attempt.
      deferUploadTurn(item, 15_000L);
      return true;
    }
    JSONObject turn = response.getJSONObject("queue");
    if (turn.optBoolean("allowed") || !java.util.Arrays.asList("pending", "queued", "retrying", "uploading")
        .contains(turn.optString("state"))) return false;
    deferUploadTurn(item, 5_000L);
    return true;
  }

  // Commit the verified remote result first. A failed delete is local cleanup,
  // never a failed transfer or a reason to send the file again.
  boolean saveVerifiedUpload(JSONObject item, File file) throws Exception {
    synchronized (vault) {
      persistVerifiedUpload(item);
      return releaseVerifiedUploadCopy(item, file);
    }
  }

  private void persistVerifiedUpload(JSONObject item) throws Exception {
    item.put("status", "uploaded")
        .put("progress", 100)
        .put("cleanupPending", true)
        .put("presenceReportPending", true)
        .put("serverRetryRequired", false)
        .put("failureReportPending", false)
        .put("waitingForUploadTurn", false)
        .put("lastError", "")
        .put("nextRetryAt", 0);
    saveQueueItem(item);
  }

  private boolean releaseVerifiedUploadCopy(JSONObject item, File file) throws Exception {
    if (exportWorkerRunning.get() || !belongsToCurrentDevice(item)) return false;
    if (file.exists() && (!file.isFile() || !file.delete())) return false;
    item.put("cleanupPending", false).put("localAvailable", false).put("presenceReportPending", true);
    saveQueueItem(item);
    return true;
  }

  void finishPendingUploadedCopies() throws Exception {
    synchronized (vault) {
      JSONArray items = queue();
      for (int i = 0; i < items.length(); i++) {
        JSONObject item = items.optJSONObject(i);
        if (item == null || !item.optBoolean("cleanupPending") || !"uploaded".equals(item.optString("status"))
            || !belongsToCurrentDevice(item)) continue;
        String sid = item.getString("id");
        try {
          UUID.fromString(sid);
          // A previous journal write may have failed after updating memory.
          // Recommit the verified state before attempting deletion on this pass.
          saveQueueItem(item);
          releaseVerifiedUploadCopy(item, new File(new File(context.getFilesDir(), "recordings"), sid + ".mp4"));
        } catch (Exception ignored) {
          // Retain the private copy for the next cleanup pass.
        }
      }
    }
  }

  private void upload(JSONObject item, BackgroundTransfers.Ticket ticket) {
    String sid = item.optString("id");
    File file = new File(new File(context.getFilesDir(), "recordings"), sid + ".mp4");
    RecorderDiagnostics.Trace trace=diagnostics.begin(item.optString("device"),"upload",sid,
        queuedWorkCount(),item.optInt("retryCount"),file.length());
    boolean yieldWhenQueued = supportsUploadBackoff();
    boolean verifiedUpload = false;
    try {
      ticket.check();
      UUID.fromString(sid);
      if (yieldWhenQueued && stillWaitingForUploadTurn(item)) return;
      ticket.check();
      trace.stage("validate");
      boolean retryServerQueue =
          item.optBoolean("serverRetryRequired")
              || (!item.optBoolean("waitingForUploadTurn") && item.optInt("retryCount", 0) > 0)
              || "retrying".equals(item.optString("status"));
      item.put("failureReportPending", false);
      saveQueueItem(item);
      if (!file.isFile() || file.length() < 1024)
        throw new Exception("The locally saved video is missing or incomplete.");
      try {
        releaseCapturedRecording(item);
      } catch (Exception ignored) {
        // Branding can proceed offline. `saved` performs the same idempotent
        // release when the final branded bytes are ready.
      }
      long durationMs = item.optLong("durationMs", -1);
      boolean audioExpected =
          item.has("audioExpected")
              ? item.optBoolean("audioExpected")
              : expectsAudio(vault.object("camera"));
      if (item.optBoolean("liveLogoRequired")) {
        durationMs = liveRecordingValidation.validate(file, item.optLong("captureDurationMs", durationMs), audioExpected);
        item.put("durationMs", durationMs).put("branded", true).put("brandingState", "complete")
            .put("validationPending", false).put("validationFailed", false);
      } else if (!item.optBoolean("branded", false)) {
        trace.stage("branding");
        item
            .put("status", "saved_locally")
            .put("brandingState", "processing")
            .put("brandingProgress", 0)
            .put("progress", 0)
            .put("lastError", LOGO_PROCESSING);
        saveQueueItem(item);
        try {
          reportQueueItem(new JSONObject(item.toString()));
        } catch (Exception ignored) {
        }
        try { durationMs =
            VideoBranding.apply(context, file, durationMs, audioExpected, ticket::cancelled, percent -> {
              try {
                item.put("brandingProgress", percent);
                saveQueueItem(item);
                TransferService.updateBrandingProgress(percent);
              } catch (Exception ignored) { }
            });
        } finally { TransferService.finishBranding(); }
        item
            .put("durationMs", durationMs)
            .put("branded", true)
            .put("brandingState", "complete");
      } else {
        RecordedVideo.validate(file, durationMs, audioExpected);
        item.put("brandingState", "complete");
      }
      ticket.check();
      item.put("brandingProgress", 100).put("validationPending", false).put("validationFailed", false);
      item
          .put("status", "pending")
          .put("bytes", file.length())
          .put("lastError", "");
      saveQueueItem(item);
      trace.stage("saved_report");
      JSONObject savedFields =
          captureEventFields(item)
              .put("bytes", file.length())
              .put("mime", "video/mp4")
              .put("branding_state", "complete");
      if (durationMs >= 0) savedFields.put("duration_ms", durationMs);
      JSONObject saved = api.tablet("saved", savedFields);
      if (saved.optBoolean("localOnly")) {
        item
            .put("status", "local_only")
            .put("lastError", new LocalOnlyException(sid).getMessage())
            .put("nextRetryAt", 0);
        saveQueueItem(item);
        trace.finish(null);
        if (sid.equals(latestSavedSession) && "complete".equals(phase))
          message = "Recording saved locally. Clips under 1 minute are not uploaded or emailed.";
        return;
      }
      if (!saved.optBoolean("ready")) {
        uploadPercent = -1;
        final JSONObject uploading = item;
        trace.stage("transfer");
        UploadTransfer.send(
            file.length(),
            ticket.guard(api.uploadTransport(sid, file)),
            new UploadTransfer.Progress() {
              public void update(long percent) {
                try {
                  uploading.put("status", "uploading").put("progress", percent)
                      .put("waitingForUploadTurn", false).put("nextQueueCheckAt", 0);
                  saveQueueItem(uploading);
                  uploadPercent = (int) percent;
                  TransferService.updateUploadProgress(uploadPercent);
                } catch (Exception ignored) { }
              }
              public void acknowledged(long bytes, long total) {
                trace.stage("transfer");
                trace.acknowledged(bytes);
                try { uploading.put("uploadedBytes", bytes); } catch (JSONException ignored) { }
                UploadTransfer.Progress.super.acknowledged(bytes, total);
              }
              public void verifying(long bytes) {
                trace.acknowledged(bytes);
                trace.stage("verify");
                verifyingUploadSession = sid;
                try { uploading.put("uploadedBytes", bytes); } catch (JSONException ignored) { }
                update(99);
              }
            },
            waiting -> {
              trace.stage("queue_wait");
              if (yieldWhenQueued) return;
              try {
                uploading.put("status", "pending");
                saveQueueItem(uploading);
                uploadPercent = -1;
                TransferService.updateUploadProgress(-1);
              } catch (Exception ignored) {
              }
            },
            retryServerQueue, yieldWhenQueued);
      }
      verifiedUpload = true;
      trace.stage("cleanup");
      boolean released = saveVerifiedUpload(item, file);
      trace.finish(released ? null : new java.io.IOException("Private upload copy cleanup is pending."));
      uploadPercent = 100;
      TransferService.updateUploadProgress(100);
      if (sid.equals(latestSavedSession) && "complete".equals(phase))
        message = "Upload complete. The replay email is being sent.";
    } catch (UploadTransfer.WaitingForTurn waiting) {
      trace.waitingForUploadTurn();
      try { deferUploadTurn(item, 5_000L); }
      catch (Exception ignored) { /* A restart can recover the durable job. */ }
    } catch (Exception failure) {
      if (!verifiedUpload && ticket.cancelled()) {
        trace.pausedBySystem();
        try { pauseUploadItem(item); } catch (Exception ignored) { }
        return;
      }
      if (verifiedUpload) {
        trace.finish(failure);
        // Do not replace a verified upload with an automatic retry if local persistence fails.
        uploadPercent = -1;
        if (sid.equals(latestSavedSession) && "complete".equals(phase))
          message = "Upload complete. The app copy will be released when device storage is available.";
        return;
      }
      try {
        int retries = item.optInt("retryCount", 0) + 1;
        String failureMessage =
            failure.getMessage() == null ? "Upload temporarily unavailable." : failure.getMessage();
        boolean validationFailed =
            failure instanceof RecordingAccuracy.Failure
                || failureMessage.contains("missing or incomplete")
                || failureMessage.contains("not playable");
        if (!file.isFile() || file.length() == 0) item.put("localAvailable", false);
        boolean permanent =
            validationFailed
                || retries >= 8
                || failure instanceof UploadTransfer.CancelledException
                || failureMessage.contains("missing or incomplete")
                || failureMessage.contains("does not belong");
        long delay = Math.min(15 * 60_000L, 5_000L * (1L << Math.min(7, retries - 1)));
        item
            .put("status", permanent ? "failed" : "retrying")
            .put("retryCount", retries)
            .put("serverRetryRequired", true)
            .put("failureReportPending", true)
            .put("waitingForUploadTurn", false)
            .put("nextQueueCheckAt", 0)
            .put("validationFailed", validationFailed)
            .put("lastError", failureMessage)
            .put("nextRetryAt", permanent ? 0 : System.currentTimeMillis() + delay + ThreadLocalRandom.current().nextLong(Math.max(1_000L, delay / 4L)));
        if (!item.optBoolean("branded", false) && item.has("brandingState") && !item.optBoolean("liveLogoRequired"))
          item.put("brandingState", "failed");
        if (validationFailed) item.put("validationPending", false);
        if (!permanent) trace.retryDelay(Math.max(0, item.optLong("nextRetryAt") - System.currentTimeMillis()));
        trace.finish(failure);
        saveQueueItem(item);
        uploadPercent = -1;
        TransferService.updateUploadProgress(-1);
        if (sid.equals(latestSavedSession) && "complete".equals(phase))
          message =
              (item.optBoolean("branded", false) ? "Upload" : "Logo processing")
                  + (permanent ? " needs attention. Your video is still safe on this tablet."
                    : " paused. Retrying automatically; your video remains saved on this device.");
        try {
          reportUploadFailure(item);
        } catch (Exception ignored) {
        }
      } catch (Exception ignored) {
        trace.finish(failure);
      }
    } finally {
      verifyingUploadSession = "";
    }
  }

  void discard() {
    if (!claim()) return;
    work.execute(
        () -> {
          try {
            JSONObject p = vault.object("pending");
            String id = p.getString("id");
            UUID.fromString(id);
            JSONObject current = api.call("/api/tablet", null),
                session = current.optJSONObject("session");
            if (session != null && id.equals(session.optString("id"))) {
              String status = session.optString("status");
              if (status.equals("requested") || status.equals("recording"))
                api.tablet("failed", new JSONObject().put("id", id));
              api.tablet("reset", new JSONObject().put("id", id));
            } else
              throw new Exception(
                  "The saved recording does not match this tablet session. Ask the administrator.");
            File f = new File(new File(context.getFilesDir(), "recordings"), id + ".mp4");
            if (f.exists() && !f.delete()) throw new Exception("Unable to remove the local video.");
            vault.put("pending", "");
            vault.put("start-request", "");
            phase = "idle";
            message = "";
            elapsed = 0;
          } catch (Exception e) {
            error = e.getMessage();
          } finally {
            finishWork();
          }
        });
  }

  void reset() {
    if (!claim()) return;
    work.execute(
        () -> {
          try {
            refresh();
            JSONObject s = server.optJSONObject("session");
            if (s != null) api.tablet("reset", new JSONObject().put("id", s.getString("id")));
            phase = "idle";
            message = "";
            elapsed = 0;
            error = "";
          } catch (Exception e) {
            error = e.getMessage();
          } finally {
            busy = false;
            refresh();
          }
        });
  }
}
