package com.casabatik.recorder;

import android.content.Context;
import android.content.Intent;
import java.io.File;
import java.util.HashSet;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

final class Engine {
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
  volatile boolean visible = false;
  volatile String attemptedRevision = "";
  volatile JSONObject server = new JSONObject();

  Engine(Context c) {
    context = c.getApplicationContext();
    vault = new Vault(context);
    api = new Api(vault);
    migratePendingRecording();
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
              refresh();
              reportFailedCaptureIfNeeded();
              syncIfNeeded();
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
        } else if ("recording".equals(item.optString("status"))) {
          item
              .put("status", "failed")
              .put("lastError", "Recording was interrupted when the app stopped.")
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
              .put("localAvailable", item.optBoolean("localAvailable", true)));
    }
    return result;
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
      reconcileServerUploadRequests();
    } catch (Exception e) {
      if (!busy) error = e.getMessage();
    }
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
      if (!"failed".equals(local.optString("status"))
          || !local.optBoolean("localAvailable", true)
          || !file.isFile()
          || file.length() < 1024) continue;
      try {
        local
            .put("status", "pending")
            .put("retryCount", 0)
            .put("serverRetryRequired", true)
            .put("lastError", "")
            .put("nextRetryAt", 0);
        saveQueueItem(local);
      } catch (Exception ignored) {
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
      int currentElapsed =
          "recording".equals(phase) && recordingStartedNanos > 0
              ? (int) ((System.nanoTime() - recordingStartedNanos) / 1_000_000_000L)
              : elapsed;
      JSONObject s =
          new JSONObject()
              .put("enabled", server.optBoolean("enabled"))
              .put("busy", busy)
              .put("phase", phase)
              .put("message", message)
              .put("error", error)
              .put("elapsed", Math.max(0, currentElapsed))
              .put("uploadPercent", uploadPercent)
              .put("countdown", countdown)
              .put("pending", hasLocalQueue())
              .put("queue", publicQueue())
              .put("tested", cameraReady(device))
              .put("cameraMode", cameraMode())
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

  void startService() {
    context.startForegroundService(new Intent(context, RecorderService.class));
  }

  boolean usesDeviceCamera() {
    JSONObject device = server.optJSONObject("device");
    return device != null && "android-camera-v1".equals(device.optString("video_device"));
  }

  boolean usesWifiCamera() {
    JSONObject device = server.optJSONObject("device");
    return device != null && "android-rtsp-v2".equals(device.optString("video_device"));
  }

  String cameraMode() {
    if (usesDeviceCamera()) return "device";
    if (usesWifiCamera()) return "wifi";
    return "";
  }

  void clearCameraCache() {
    try {
      vault.put("camera", "");
      vault.put("camera-revision", "");
    } catch (Exception ignored) {
    }
  }

  long captureCamera(
      JSONObject camera,
      File file,
      int seconds,
      int countInSeconds,
      RtspRecorder.Listener listener)
      throws Exception {
    if ("device".equals(camera.optString("type"))) {
      return DeviceCameraRecorder.capture(
          context, file, seconds, countInSeconds, () -> stop, listener);
    }
    return RtspRecorder.capture(
        RtspRecorder.cameraUri(
            camera.getString("address"),
            camera.optString("user"),
            camera.optString("password")),
        file,
        seconds,
        camera.optBoolean("audio"),
        countInSeconds,
        () -> stop,
        listener);
  }

  boolean expectsAudio(JSONObject camera) {
    return "device".equals(camera.optString("type")) || camera.optBoolean("audio");
  }

  void finishWork() {
    busy = false;
    if (!uploadWorkerRunning.get())
      context.stopService(new Intent(context, RecorderService.class));
    refresh();
  }

  void enroll(String code) {
    if (!claim()) return;
    work.execute(
        () -> {
          try {
            api.call("/api/tablet/enroll", new JSONObject().put("code", code.trim()));
            message = "Tablet enrolled. Retrieving its assigned camera settings…";
            refresh();
          } catch (Exception e) {
            error = e.getMessage();
          } finally {
            busy = false;
            if (server.optBoolean("enabled")) {
              if (usesDeviceCamera() && !DeviceCameraRecorder.hasPermissions(context))
                message = "Open Device setup and allow camera and microphone access.";
              else syncCamera();
            }
          }
        });
  }

  boolean cameraReady(JSONObject d) {
    return d != null
        && "android_rtsp".equals(d.optString("recorder_mode"))
        && ("android-camera-v1".equals(d.optString("video_device"))
            || "android-rtsp-v2".equals(d.optString("video_device")))
        && !d.isNull("tested_at")
        && !vault.get("camera").isEmpty()
        && vault.get("camera-revision").equals(d.optString("config_revision"))
        && vault.get("camera-revision").equals(d.optString("tested_revision"));
  }

  void syncIfNeeded() {
    JSONObject d = server.optJSONObject("device"), session = server.optJSONObject("session");
    if (!visible
        || busy
        || d == null
        || !"android_rtsp".equals(d.optString("recorder_mode"))) return;
    if (session != null && activeCaptureStatus(session.optString("status"))) return;
    String revision = d.optString("config_revision");
    if (!revision.isEmpty()
        && !revision.equals(attemptedRevision)
        && (!cameraReady(d) || d.optBoolean("test_requested"))) syncCamera();
  }

  void syncCamera() {
    if (!visible || !claim()) return;
    try {
      startService();
    } catch (Exception e) {
      busy = false;
      error = "Open the app and retry the camera test.";
      return;
    }
    phase = "testing";
    message =
        usesDeviceCamera()
            ? "Testing this Android device’s camera…"
            : "Connecting to and testing the external Tapo camera…";
    work.execute(
        () -> {
          File test = new File(context.getCacheDir(), "camera-test.mp4");
          String revision = "";
          boolean reported = false;
          boolean passed = false;
          final String[] testedCamera = {""};
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
            message =
                "device".equals(camera.optString("type"))
                    ? "Testing this Android device’s camera…"
                    : "Connecting to and testing the external Tapo camera…";
            vault.put("camera", "");
            vault.put("camera-revision", "");
            try {
              long capturedMillis = captureCamera(
                  camera,
                  test,
                  4,
                  0,
                  new RtspRecorder.Listener() {
                    public void ready() {}

                    public void countdown(int value) {}

                    public void started() {}

                    public void camera(String label) {
                      testedCamera[0] = label;
                    }

                    public void frame(int seconds) {
                      elapsed = seconds;
                    }
                  });
              RtspRecorder.validate(test, capturedMillis, expectsAudio(camera));
            } catch (Exception e) {
              String reason = e.getMessage();
              if ("device".equals(camera.optString("type")))
                throw new Exception(
                    reason != null && reason.contains("USB camera")
                        ? reason
                        : "Camera test failed. Allow camera and microphone permissions, then retry.");
              throw new Exception(
                  "External Wi-Fi camera test failed. Check the Tapo Camera Account, IP address,"
                      + " and local network, then retry.");
            }
            api.call(
                "/api/tablet/camera",
                new JSONObject()
                    .put("action", "tested")
                    .put("revision", revision)
                    .put("passed", true));
            reported = true;
            vault.put("camera", camera.toString());
            vault.put("camera-revision", revision);
            passed = true;
            message =
                testedCamera[0].isEmpty()
                    ? "Camera test passed. Ready to record."
                    : "Camera test passed (" + testedCamera[0] + "). Ready to record.";
          } catch (Exception e) {
            error = e.getMessage();
            message = "Camera setup needs attention.";
            if (!revision.isEmpty()) clearCameraCache();
            if (!revision.isEmpty() && !reported)
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
            test.delete();
            phase = passed ? "idle" : "error";
            elapsed = 0;
            finishWork();
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
      if (usesWifiCamera())
        error =
            "The external Tapo camera test has not passed. Open Device setup and test the Tapo camera first.";
      else if (usesDeviceCamera())
        error =
            "The Android camera test has not passed. Open Device setup, allow camera and microphone access, then test again.";
      else
        error =
            "Choose a supported camera mode in Admin / Devices & cameras, then test it in Device setup.";
      return;
    }
    if (!claim()) return;
    try {
      startService();
    } catch (Exception e) {
      busy = false;
      phase = "error";
      error =
          usesDeviceCamera()
              ? "Allow camera and microphone permissions, then try again."
              : "The recorder could not start. Keep the Android gateway awake and try again.";
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
                  new RtspRecorder.Listener() {
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
              throw new Exception(
                  (e instanceof RecordingAccuracy.Failure ? e.getMessage() + " " : "Recording interrupted. ")
                      + "Any saved footage stays on this tablet. Choose Recover"
                      + " upload.");
            }
            RtspRecorder.validate(file, capturedMillis, expectsAudio(camera));
            api.tablet("stopped", new JSONObject().put("id", sid));
            JSONObject queued = queueItem(sid);
            queued
                .put("durationMs", capturedMillis)
                .put("bytes", file.length())
                .put("status", "saved_locally")
                .put("lastError", "")
                .put("nextRetryAt", 0);
            saveQueueItem(queued);
            phase = "complete";
            message =
                capturedMillis < 60_000
                    ? "Recording saved locally. Clips under 1 minute are not uploaded or emailed."
                    : "Video complete. Check your Gmail later for the replay link.";
            kickUploads();
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
      if (item.length() == 0 || !item.optBoolean("localAvailable", true)) return;
      item
          .put("status", "pending")
          .put("retryCount", 0)
          .put("serverRetryRequired", true)
          .put("lastError", "")
          .put("nextRetryAt", 0);
      saveQueueItem(item);
      kickUploads();
    } catch (Exception e) {
      error = "This saved video could not be retried.";
    }
  }

  private JSONObject nextUpload() {
    long now = System.currentTimeMillis();
    JSONArray current = queue();
    JSONObject selected = null;
    for (int index = 0; index < current.length(); index++) {
      JSONObject item = current.optJSONObject(index);
      if (item == null || !item.optBoolean("localAvailable", true)) continue;
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
    try {
      startService();
    } catch (Exception e) {
      uploadWorkerRunning.set(false);
      return;
    }
    uploads.execute(
        () -> {
          try {
            JSONObject item;
            while ((item = nextUpload()) != null) upload(item);
          } finally {
            uploadWorkerRunning.set(false);
            if (!busy) context.stopService(new Intent(context, RecorderService.class));
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
      if (!file.isFile() || file.length() < 1024)
        throw new Exception("The locally saved video is missing or incomplete.");
      long durationMs = item.optLong("durationMs", -1);
      boolean audioExpected =
          item.has("audioExpected")
              ? item.optBoolean("audioExpected")
              : expectsAudio(vault.object("camera"));
      RtspRecorder.validate(file, durationMs, audioExpected);
      item
          .put("status", "pending")
          .put("bytes", file.length())
          .put("lastError", "");
      saveQueueItem(item);
      JSONObject savedFields =
          new JSONObject()
              .put("id", sid)
              .put("bytes", file.length())
              .put("mime", "video/mp4");
      if (durationMs >= 0) savedFields.put("duration_ms", durationMs);
      JSONObject saved = api.tablet("saved", savedFields);
      if (saved.optBoolean("localOnly")) {
        item
            .put("status", "local_only")
            .put("lastError", new LocalOnlyException(sid).getMessage())
            .put("nextRetryAt", 0);
        saveQueueItem(item);
        return;
      }
      item.put("status", "uploading").put("progress", 0);
      saveQueueItem(item);
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
            } catch (Exception ignored) {
            }
          },
          waiting -> {
            try {
              uploading.put("status", "pending").put("progress", waiting.optInt("percent", 0));
              saveQueueItem(uploading);
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
    } catch (Exception failure) {
      try {
        int retries = item.optInt("retryCount", 0) + 1;
        String failureMessage =
            failure.getMessage() == null ? "Upload temporarily unavailable." : failure.getMessage();
        boolean permanent =
            retries >= 8
                || failure instanceof UploadTransfer.CancelledException
                || failureMessage.contains("missing or incomplete")
                || failureMessage.contains("does not belong");
        long delay = Math.min(15 * 60_000L, 5_000L * (1L << Math.min(7, retries - 1)));
        item
            .put("status", permanent ? "failed" : "retrying")
            .put("retryCount", retries)
            .put("serverRetryRequired", true)
            .put("lastError", failureMessage)
            .put("nextRetryAt", permanent ? 0 : System.currentTimeMillis() + delay + ThreadLocalRandom.current().nextLong(Math.max(1_000L, delay / 4L)));
        saveQueueItem(item);
        try {
          api.tablet("upload-failed", new JSONObject().put("id", sid));
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
