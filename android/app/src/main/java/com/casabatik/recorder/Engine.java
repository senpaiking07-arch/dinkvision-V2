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
import org.json.JSONObject;

final class Engine {
  private static final String LOGO_PROCESSING = "Adding Dink Vision logo.";
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
  final ExecutorService work = Executors.newSingleThreadExecutor();
  final ExecutorService uploads = Executors.newSingleThreadExecutor();
  final ScheduledExecutorService heartbeat = Executors.newSingleThreadScheduledExecutor();
  final AtomicBoolean uploadWorkerRunning = new AtomicBoolean(false);
  volatile boolean busy = false, stop = false;
  volatile String phase = "idle", message = "", error = "";
  volatile int elapsed = 0, countdown = 0;
  volatile int uploadPercent = -1;
  volatile long recordingStartedNanos = 0;
  volatile String activeSession = "";
  volatile String latestSavedSession = "";
  volatile boolean visible = false;
  volatile boolean initialized = false;
  volatile String attemptedRevision = "";
  volatile boolean cameraTestReady = false;
  volatile boolean cameraTestHasAudio = false;
  volatile String cameraTestRevision = "";
  volatile String cameraTestCamera = "";
  volatile String cameraTestToken = "";
  volatile JSONObject server = new JSONObject();

  Engine(Context c) {
    this(c, null);
  }

  Engine(Context c, Api.Connections connections) {
    context = c.getApplicationContext();
    vault = new Vault(context);
    api = connections == null ? new Api(vault) : new Api(vault, connections);
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
          try {
            if (server.optBoolean("enabled")) {
              // Re-send the transition while recording so a dropped Android
              // request cannot leave the admin dashboard stuck on “starting”.
              if (busy && "recording".equals(phase) && !activeSession.isEmpty())
                api.tablet("started", new JSONObject().put("id", activeSession));
              else api.tablet("heartbeat", new JSONObject());
            }
            if (!busy) {
              releaseCapturedRecordings();
              reportPendingUploadFailures();
              refresh();
              reportFailedCaptureIfNeeded();
            }
            kickUploads();
          } catch (Exception ignored) {
          }
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
          item.put("localAvailable", true).put("status", "pending").put("bytes", file.length());
          saveQueueItem(item);
        } else if ("uploading".equals(item.optString("status"))) {
          int retries = item.optInt("retryCount", 0) + 1;
          item
              .put("status", retries >= 8 ? "failed" : "retrying")
              .put("retryCount", retries)
              .put("lastError", "Upload was interrupted when the app stopped.")
              .put("nextRetryAt", retries >= 8 ? 0 : System.currentTimeMillis() + 5_000L)
              .put("bytes", file.length());
          saveQueueItem(item);
        } else if ("recording".equals(item.optString("status"))) {
          item
              .put("status", "pending")
              .put("lastError", "Recording was interrupted and will be validated before upload.")
              .put("nextRetryAt", 0)
              .put("bytes", file.length());
          saveQueueItem(item);
        }
      }
    } catch (Exception e) {
      error = "Could not reconcile locally saved videos.";
    }
  }

  private JSONArray queue() {
    synchronized (vault) {
      return vault.array("upload-queue");
    }
  }

  private void upsertQueueLocked(JSONObject item) throws Exception {
    JSONArray current = vault.array("upload-queue"), updated = new JSONArray();
    String id = item.optString("id");
    boolean replaced = false;
    for (int index = 0; index < current.length(); index++) {
      JSONObject existing = current.optJSONObject(index);
      if (existing == null) continue;
      if (id.equals(existing.optString("id"))) {
        updated.put(new JSONObject(item.toString()));
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
      if (item == null) continue;
      result.put(
          new JSONObject()
              .put("id", item.optString("id"))
              .put("jobId", item.optString("jobId", item.optString("id")))
              .put("status", item.optString("status", "saved_locally"))
              .put("progress", item.optInt("progress", 0))
              .put("retryCount", item.optInt("retryCount", 0))
              .put("lastError", item.optString("lastError"))
              .put("createdAt", item.optLong("createdAt"))
              .put("bytes", item.optLong("bytes"))
              .put("durationMs", item.optLong("durationMs"))
              .put("captureReleased", item.optBoolean("captureReleased", false))
              .put("localAvailable", item.optBoolean("localAvailable", true)));
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
            .put("uploaded_bytes", 0);
    if (item.has("brandingState"))
      report.put("branding_state", item.optString("brandingState"));
    if (item.has("durationMs")) report.put("duration_ms", item.optLong("durationMs"));
    api.tablet("queue-report", report);
  }

  private void releaseCapturedRecording(JSONObject item) throws Exception {
    if (item.optBoolean("captureReleased", false)) return;
    String status = item.optString("status", "saved_locally");
    if (!java.util.Arrays.asList("saved_locally", "pending", "retrying", "uploading")
        .contains(status)) return;
    String sid = item.optString("id");
    UUID.fromString(sid);
    File file = new File(new File(context.getFilesDir(), "recordings"), sid + ".mp4");
    if (!file.isFile() || file.length() < 1) return;
    api.tablet("captured", new JSONObject().put("id", sid));
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

  synchronized boolean claim() {
    if (busy) return false;
    busy = true;
    error = "";
    stop = false;
    return true;
  }

  void refresh() {
    try {
      server = api.call("/api/tablet", null);
      initialized = true;
      reconcileServerUploadRequests();
    } catch (Exception e) {
      if (!busy) error = e.getMessage();
    }
  }

  void refreshConfiguration() {
    if (!claim()) return;
    message = "Checking this tablet’s saved assignment…";
    work.execute(
        () -> {
          try {
            server = api.call("/api/tablet", null);
            initialized = true;
            reconcileServerUploadRequests();
            error = "";
            if (server.optBoolean("enabled") && cameraMode().isEmpty()) {
              message =
                  "This tablet is enrolled. Open Device setup and choose its camera without entering another code.";
            }
          } catch (Exception e) {
            error = e.getMessage();
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
    JSONObject response = api.tablet(
        "upload-failed",
        new JSONObject()
            .put("id", item.getString("id"))
            .put("retry_count", item.optInt("retryCount"))
            .put("retrying", "retrying".equals(item.optString("status")))
            .put("last_error", item.optString("lastError"))
            .put("validation_failed", item.optBoolean("validationFailed"))
            .put("branding_state", item.optString("brandingState")));
    synchronized (vault) {
      JSONObject current = queueItem(item.getString("id"));
      if (!current.optBoolean("failureReportPending")
          || current.optInt("retryCount") != item.optInt("retryCount")
          || !current.optString("status").equals(item.optString("status"))) return;
      current.put("failureReportPending", false);
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
      try {
        reportUploadFailure(item);
      } catch (Exception ignored) {
        // Keep the pending report durable until the device can contact the server.
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
    if (!"failed".equals(item.optString("status"))) return;
    try {
      api.tablet("failed", new JSONObject().put("id", id));
      refresh();
    } catch (Exception ignored) {
    }
  }

  String snapshot() {
    try {
      JSONObject device = server.optJSONObject("device");
      JSONObject recovery = latestRecoverableRecording();
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
              .put("busy", busy)
              .put("phase", phase)
              .put("message", message)
              .put("error", error)
              .put("version", BuildConfig.VERSION_NAME)
              .put("elapsed", Math.max(0, currentElapsed))
              .put("elapsedMs", Math.max(0L, currentElapsedMillis))
              .put("uploadPercent", uploadPercent)
              .put("countdown", countdown)
              .put("pending", hasLocalQueue())
              .put("recoverable", recovery.length() > 0)
              .put("recoveryKind", recovery.length() == 0 ? "" :
                  recovery.has("durationMs") ? "upload" : "partial")
              .put("tested", cameraReady(device))
              .put("cameraMode", cameraMode())
              .put("testReady", cameraTestReady)
              .put("testHasAudio", cameraTestHasAudio)
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
    context.startForegroundService(
        new Intent(context, RecorderService.class)
            .putExtra(RecorderService.EXTRA_CAMERA_ACTIVE, cameraActive)
            .putExtra(RecorderService.EXTRA_UPLOAD_ACTIVE, uploadActive));
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
    try {
      vault.put("camera", "");
      vault.put("camera-revision", "");
    } catch (Exception ignored) {
    }
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
            clearCameraCache();
            attemptedRevision = "";
            server = api.call("/api/tablet", null);
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
        context, file, seconds, countInSeconds, () -> stop, listener);
  }

  boolean expectsAudio(JSONObject camera) {
    return "device".equals(camera.optString("type"));
  }

  void finishWork() {
    busy = false;
    if (!uploadWorkerRunning.get() && !hasPendingUploadWork()) RecorderService.stopWhenIdle();
    refresh();
  }

  void enroll(String code, boolean replace) {
    if (!claim()) return;
    work.execute(
        () -> {
          try {
            api.call(
                "/api/tablet/enroll",
                new JSONObject().put("code", code.trim()).put("replace", replace));
            clearCameraCache();
            error = "";
            message = "Tablet enrolled. Retrieving its assigned camera settings…";
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
    return d != null
        && "android_rtsp".equals(d.optString("recorder_mode"))
        && "android-camera-v1".equals(d.optString("video_device"))
        && !d.isNull("tested_at")
        && !vault.get("camera").isEmpty()
        && vault.get("camera-revision").equals(d.optString("config_revision"))
        && vault.get("camera-revision").equals(d.optString("tested_revision"));
  }

  void syncCamera() {
    if (!usesDeviceCamera()) {
      error = "";
      message =
          server.optBoolean("enabled")
              ? "This tablet is enrolled. Open Device setup and choose its camera."
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
            server = api.call("/api/tablet", null);
            JSONObject session = server.optJSONObject("session");
            if (session != null && activeCaptureStatus(session.optString("status")))
              throw new Exception("Finish or recover the current match before testing.");
            JSONObject config =
                api.call("/api/tablet/camera", new JSONObject().put("action", "configuration"));
            revision = config.getString("revision");
            attemptedRevision = revision;
            JSONObject camera = config.getJSONObject("camera");
            message = "Testing this Android device’s USB or built-in camera…";
            vault.put("camera", "");
            vault.put("camera-revision", "");
            try {
              long capturedMillis = captureCamera(
                  camera,
                  test,
                  4,
                  0,
                  new CameraCapture.Listener() {
                    public void ready() {}

                    public void countdown(int value) {}

                    public void started() {}

                    public void camera(String label) {}

                    public void frame(int seconds) {
                      elapsed = seconds;
                    }
                  });
              message = "Adding the Dink Vision logo to the test clip…";
              capturedMillis =
                  VideoBranding.applyPreview(
                      context, test, capturedMillis, expectsAudio(camera), 3_000L);
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
            cameraTestCamera = camera.toString();
            cameraTestHasAudio = expectsAudio(camera);
            cameraTestToken = revision + "-" + System.currentTimeMillis();
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
            phase = readyForReview ? "review" : "error";
            elapsed = 0;
            finishWork();
          }
        });
  }

  void confirmCameraTest(boolean accepted, boolean retry) {
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
            else if (!uploadWorkerRunning.get()) RecorderService.stopWhenIdle();
          });
      return;
    }
    work.execute(
        () -> {
          boolean updated = false;
          try {
            api.call(
                "/api/tablet/camera",
                new JSONObject()
                    .put("action", "tested")
                    .put("revision", revision)
                    .put("passed", accepted));
            if (accepted) {
              vault.put("camera", camera);
              vault.put("camera-revision", revision);
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
            if (!uploadWorkerRunning.get()) RecorderService.stopWhenIdle();
            refresh();
          }
        });
  }

  private JSONArray recipientEmails(String payload) throws Exception {
    JSONArray input = new JSONArray(payload), result = new JSONArray();
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

  void start(String recipientJson) {
    final JSONArray recipients;
    try {
      recipients = recipientEmails(recipientJson);
    } catch (Exception e) {
      phase = "error";
      error = e.getMessage();
      return;
    }
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
      return;
    }
    if (!claim()) return;
    try {
      startService(true, false);
    } catch (Exception e) {
      busy = false;
      phase = "error";
      error = "Allow camera and microphone permissions, then try again.";
      return;
    }
    phase = "connecting";
    message = "Connecting to your court camera…";
    work.execute(
        () -> {
          String sid = "";
          File file = null;
          try {
            JSONObject camera = vault.object("camera");
            if (camera.length() == 0) throw new Exception("Configure and test the camera first.");
            releaseCapturedRecordings();
            server = api.call("/api/tablet", null);
            JSONObject device = server.optJSONObject("device");
            if (device == null) throw new Exception("Enroll this tablet first.");
            if (!cameraReady(device))
              throw new Exception("Camera settings changed. Open Device setup and retry the test.");
            int seconds = server.optInt("maxSeconds", 900);
            if (seconds < 1 || seconds > 7200) throw new Exception("Invalid recording limit.");
            File dir = new File(context.getFilesDir(), "recordings");
            dir.mkdirs();
            if (dir.getUsableSpace() < seconds * 500000L + 100_000_000)
              throw new Exception("Not enough tablet storage for this match.");
            JSONObject attempt = vault.object("start-request");
            if (!recipients.toString().equals(attempt.optJSONArray("emails") == null ? "" : attempt.optJSONArray("emails").toString()))
              attempt =
                  new JSONObject().put("email", email).put("emails", recipients).put("key", UUID.randomUUID().toString());
            vault.put("start-request", attempt.toString());
            sid =
                api.tablet(
                        "start",
                        new JSONObject(attempt.toString())
                            .put("revision", vault.get("camera-revision")))
                    .getString("id");
            UUID.fromString(sid);
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
                    .put("audioExpected", expectsAudio(camera))
                    .put("createdAt", System.currentTimeMillis())
                    .put("status", "recording")
                    .put("progress", 0)
                    .put("retryCount", 0)
                    .put("localAvailable", true));
            activeSession = sid;
            uploadPercent = -1;
            vault.put("start-request", "");
            final String id = sid;
            long capturedMillis;
            try {
              capturedMillis =
                  captureCamera(
                  camera,
                  file,
                  seconds,
                  3,
                  new CameraCapture.Listener() {
                    public void ready() {
                      phase = "countdown";
                      message = "Recording starts in 3…";
                    }

                    public void countdown(int value) {
                      countdown = value;
                      if (value > 0) {
                        phase = "countdown";
                        message = "Recording starts in " + value + "…";
                      } else {
                        phase = "connecting";
                        message = "Starting recording…";
                      }
                    }

                    public void started() throws Exception {
                      countdown = 0;
                      recordingStartedNanos = System.nanoTime();
                      elapsed = 0;
                      phase = "recording";
                      message = "Recording your match";
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

                    public void finalizing() {
                      phase = "finalizing";
                      message = "Finalizing the complete video… Keep this app open.";
                    }
                  });
            } catch (Exception e) {
              String detail = e.getMessage();
              String reason = e instanceof RecordingAccuracy.Failure
                  || (detail != null && detail.startsWith("The USB camera"))
                      ? detail : "Recording interrupted.";
              boolean savedFootage = file.isFile() && file.length() >= 1024;
              throw new Exception(reason + (savedFootage
                  ? " Any saved footage remains on this device. Use Recover saved video on the welcome screen."
                  : " Reconnect the camera and try again."));
            }
            phase = "finalizing";
            message = "Saving the complete video…";
            api.tablet("stopped", new JSONObject().put("id", sid));
            JSONObject queued = queueItem(sid);
            queued
                .put("durationMs", capturedMillis)
                .put("bytes", file.length())
                .put("branded", false)
                .put("captureReleased", false)
                .put("status", "saved_locally")
                .put("lastError", "")
                .put("nextRetryAt", 0);
            saveQueueItem(queued);
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
            message =
                capturedMillis < 60_000
                    ? "Recording saved locally. Clips under 1 minute are not uploaded or emailed."
                    : "Video saved safely. You can start another match.";
          } catch (Exception e) {
            error = e.getMessage();
            phase = "error";
            if (!sid.isEmpty())
              try {
                JSONObject failed = queueItem(sid);
                if (failed.length() > 0) {
                  failed
                      .put("status", "failed")
                      .put("lastError", error)
                      .put("bytes", file != null && file.isFile() ? file.length() : 0)
                      .put("localAvailable", file != null && file.isFile() && file.length() > 0);
                  saveQueueItem(failed);
                }
              } catch (Exception ignored) {
              }
            if (!sid.isEmpty())
              try {
                api.tablet("failed", new JSONObject().put("id", sid));
              } catch (Exception ignored) {
              }
          } finally {
            countdown = 0;
            recordingStartedNanos = 0;
            activeSession = "";
            finishWork();
            // The foreground capture is free as soon as the original file is
            // durable. Logo processing and upload continue independently.
            kickUploads();
          }
        });
  }

  void recover() {
    kickUploads();
  }

  void requestStop() {
    stop = true;
    String sid = activeSession;
    if (sid.isEmpty()) return;
    phase = "finalizing";
    message = "Stopping recording…";
    heartbeat.execute(
        () -> {
          try {
            api.tablet("stopped", new JSONObject().put("id", sid));
          } catch (Exception ignored) {
          }
        });
  }

  void retryUpload(String sid) {
    try {
      UUID.fromString(sid);
      JSONObject item = queueItem(sid);
      if (item.length() == 0
          || !item.optBoolean("localAvailable", true)
          || !belongsToCurrentDevice(item)) return;
      item
          .put("status", "pending")
          .put("retryCount", 0)
          .put("serverRetryRequired", true)
          .put("failureReportPending", false)
          .put("lastError", "")
          .put("nextRetryAt", 0);
      saveQueueItem(item);
      kickUploads();
    } catch (Exception e) {
      error = "This saved video could not be retried.";
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

  private boolean belongsToCurrentDevice(JSONObject item) {
    JSONObject device = server.optJSONObject("device");
    String currentDevice = device == null ? "" : device.optString("id");
    return !currentDevice.isEmpty() && currentDevice.equals(item.optString("device"));
  }

  File localPlaybackFile(String sid) throws Exception {
    UUID.fromString(sid);
    JSONObject item = queueItem(sid);
    if (item.length() == 0
        || !item.optBoolean("localAvailable", true)
        || !belongsToCurrentDevice(item))
      throw new Exception("This saved video is not playable for the currently enrolled device.");
    File file = new File(new File(context.getFilesDir(), "recordings"), sid + ".mp4");
    if (!file.isFile() || file.length() < 1)
      throw new Exception("This saved video is not playable because its local file is missing.");
    return file;
  }

  boolean hasPendingUploadWork() {
    JSONArray current = queue();
    for (int index = 0; index < current.length(); index++) {
      JSONObject item = current.optJSONObject(index);
      if (item == null
          || !item.optBoolean("localAvailable", true)
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

  private JSONObject nextUpload() {
    long now = System.currentTimeMillis();
    JSONArray current = queue();
    JSONObject selected = null;
    for (int index = 0; index < current.length(); index++) {
      JSONObject item = current.optJSONObject(index);
      if (item == null
          || !item.optBoolean("localAvailable", true)
          || !belongsToCurrentDevice(item)) continue;
      String status = item.optString("status", "saved_locally");
      if (!java.util.Arrays.asList("saved_locally", "pending", "retrying").contains(status)
          || item.optLong("nextRetryAt", 0) > now) continue;
      if (selected == null || item.optLong("createdAt") < selected.optLong("createdAt"))
        selected = item;
    }
    if (selected == null) return null;
    try {
      return new JSONObject(selected.toString());
    } catch (Exception ignored) {
      return null;
    }
  }

  void kickUploads() {
    if (!server.optBoolean("enabled") || !uploadWorkerRunning.compareAndSet(false, true)) return;
    JSONObject first = nextUpload();
    if (first == null) {
      uploadWorkerRunning.set(false);
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
      uploadWorkerRunning.set(false);
      return;
    }
    uploads.execute(
        () -> {
          try {
            JSONObject item = first;
            upload(item);
            while ((item = nextUpload()) != null) upload(item);
          } finally {
            uploadWorkerRunning.set(false);
            if (!busy && !hasPendingUploadWork()) RecorderService.stopWhenIdle();
          }
        });
  }

  private void upload(JSONObject item) {
    String sid = item.optString("id");
    File file = new File(new File(context.getFilesDir(), "recordings"), sid + ".mp4");
    try {
      boolean retryServerQueue =
          item.optBoolean("serverRetryRequired")
              || item.optInt("retryCount", 0) > 0
              || "retrying".equals(item.optString("status"));
      UUID.fromString(sid);
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
      if (!item.optBoolean("branded", false)) {
        item
            .put("status", "saved_locally")
            .put("brandingState", "processing")
            .put("progress", 0)
            .put("lastError", LOGO_PROCESSING);
        saveQueueItem(item);
        try {
          reportQueueItem(new JSONObject(item.toString()));
        } catch (Exception ignored) {
        }
        durationMs =
            VideoBranding.apply(context, file, durationMs, audioExpected, () -> false);
        item
            .put("durationMs", durationMs)
            .put("branded", true)
            .put("brandingState", "complete");
      } else {
        RecordedVideo.validate(file, durationMs, audioExpected);
        item.put("brandingState", "complete");
      }
      item
          .put("status", "pending")
          .put("bytes", file.length())
          .put("lastError", "");
      saveQueueItem(item);
      JSONObject savedFields =
          new JSONObject()
              .put("id", sid)
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
        if (sid.equals(latestSavedSession) && "complete".equals(phase))
          message = "Recording saved locally. Clips under 1 minute are not uploaded or emailed.";
        return;
      }
      item.put("status", "uploading").put("progress", 0);
      saveQueueItem(item);
      uploadPercent = 0;
      RecorderService.updateUploadProgress(0);
      final JSONObject uploading = item;
      UploadTransfer.send(
          file.length(),
          new UploadTransfer.Transport() {
            public JSONObject action(String action) throws Exception {
              return api.tablet(action, new JSONObject().put("id", sid));
            }

            public JSONObject chunk(long offset, int length) throws Exception {
              return api.uploadChunk(sid, file, offset, length);
            }
          },
          percent -> {
            try {
              uploading.put("status", "uploading").put("progress", percent);
              saveQueueItem(uploading);
              uploadPercent = (int) Math.max(0, Math.min(100, percent));
              RecorderService.updateUploadProgress(uploadPercent);
            } catch (Exception ignored) {
            }
          },
          waiting -> {
            try {
              uploading.put("status", "pending").put("progress", waiting.optInt("percent", 0));
              saveQueueItem(uploading);
              uploadPercent = Math.max(0, Math.min(100, waiting.optInt("percent", 0)));
              RecorderService.updateUploadProgress(uploadPercent);
            } catch (Exception ignored) {
            }
          },
          retryServerQueue);
      if (!file.delete() && file.exists())
        throw new Exception("Upload succeeded, but the local backup could not be released.");
      item
          .put("status", "uploaded")
          .put("progress", 100)
          .put("localAvailable", false)
          .put("serverRetryRequired", false)
          .put("lastError", "")
          .put("nextRetryAt", 0);
      saveQueueItem(item);
      uploadPercent = 100;
      RecorderService.updateUploadProgress(100);
      if (sid.equals(latestSavedSession) && "complete".equals(phase))
        message = "Upload complete. The replay email is being sent.";
    } catch (Exception failure) {
      try {
        int retries = item.optInt("retryCount", 0) + 1;
        String failureMessage =
            failure.getMessage() == null ? "Upload temporarily unavailable." : failure.getMessage();
        boolean validationFailed =
            failure instanceof RecordingAccuracy.Failure
                || failureMessage.contains("missing or incomplete")
                || failureMessage.contains("not playable");
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
            .put("validationFailed", validationFailed)
            .put("lastError", failureMessage)
            .put("nextRetryAt", permanent ? 0 : System.currentTimeMillis() + delay + ThreadLocalRandom.current().nextLong(Math.max(1_000L, delay / 4L)));
        if (!item.optBoolean("branded", false) && item.has("brandingState"))
          item.put("brandingState", "failed");
        saveQueueItem(item);
        uploadPercent = -1;
        if (sid.equals(latestSavedSession) && "complete".equals(phase))
          message =
              permanent
                  ? "Upload needs attention. Your video is still safe on this tablet."
                  : "Upload paused. Retrying automatically; your video remains saved on this device.";
        try {
          reportUploadFailure(item);
        } catch (Exception ignored) {
        }
      } catch (Exception ignored) {
      }
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
