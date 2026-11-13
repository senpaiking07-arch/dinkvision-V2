package com.casabatik.recorder;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class LiveRecordingValidationTest {
  @Test public void retriesRecheckTheSealAndTheOriginalValidationRequirements() throws Exception {
    File file = File.createTempFile("sealed-clip-", ".mp4",
        InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir());
    try {
      copySample(file);
      LiveLogoEvidence.mark(file);
      LiveRecordingValidation validation = new LiveRecordingValidation();
      long duration = validation.validate(file, -1, false);
      assertTrue(duration > 0);
      assertEquals(duration, validation.validate(file, -1, false));
      assertThrows(RecordingAccuracy.Failure.class, () -> validation.validate(file, 60_000, false));
      assertEquals(duration, validation.validate(file, -1, false));
      long bytes = file.length();
      try (RandomAccessFile edit = new RandomAccessFile(file, "rw")) {
        edit.seek(10);
        int original = edit.readUnsignedByte();
        edit.seek(10);
        edit.writeByte(original ^ 1);
      }
      assertEquals(bytes, file.length());
      assertTrue("The old footer alone cannot prove unchanged bytes", LiveLogoEvidence.hasSeal(file));
      assertThrows(RecordingAccuracy.Failure.class, () -> validation.validate(file, -1, false));
    } finally { file.delete(); }
  }

  @Test public void finalizedQueueHandoffBlocksPlaybackAndUploadUntilValidation() throws Exception {
    Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
    String namespace = "live-validation-" + UUID.randomUUID();
    File root = new File(base.getCacheDir(), namespace);
    File directory = new File(root, "recordings");
    assertTrue(directory.mkdirs());
    Context fixture = new ContextWrapper(base) {
      @Override public Context getApplicationContext() { return this; }
      @Override public File getFilesDir() { return root; }
      @Override public File getCacheDir() { return root; }
      @Override public SharedPreferences getSharedPreferences(String name, int mode) {
        return base.getSharedPreferences(namespace + name, mode);
      }
    };
    String device = UUID.randomUUID().toString();
    List<String> actions = new ArrayList<>();
    List<JSONObject> requests = new ArrayList<>();
    long[] savedDuration = {-1};
    Engine engine = new Engine(fixture, url -> new HttpURLConnection(url) {
      final ByteArrayOutputStream body = new ByteArrayOutputStream();
      @Override public void connect() {}
      @Override public void disconnect() {}
      @Override public boolean usingProxy() { return false; }
      @Override public OutputStream getOutputStream() { return body; }
      @Override public int getResponseCode() { return 200; }
      @Override public Map<String, List<String>> getHeaderFields() { return Map.of(); }
      @Override public InputStream getInputStream() {
        String action;
        try {
          JSONObject request = new JSONObject(body.toString("UTF-8"));
          requests.add(request);
          action = request.getString("action");
          if ("saved".equals(action)) savedDuration[0] = request.getLong("duration_ms");
        }
        catch (Exception invalid) { throw new AssertionError(invalid); }
        actions.add(action);
        return new ByteArrayInputStream(("saved".equals(action) ? "{\"localOnly\":true}" : "{\"ok\":true}")
            .getBytes(StandardCharsets.UTF_8));
      }
    });
    engine.heartbeat.shutdownNow();
    engine.server = new JSONObject().put("device", new JSONObject().put("id", device));
    File[] files = new File[3];
    try {
      var upload = Engine.class.getDeclaredMethod("upload", JSONObject.class, BackgroundTransfers.Ticket.class);
      upload.setAccessible(true);
      for (int i = 0; i < files.length; i++) {
        String sid = UUID.randomUUID().toString();
        File file = files[i] = new File(directory, sid + ".mp4");
        if (i != 1) copySample(file);
        else try (FileOutputStream out = new FileOutputStream(file)) { out.write(new byte[2048]); }
        JSONArray queue = engine.vault.array("upload-queue");
        queue.put(new JSONObject().put("id", sid).put("device", device).put("status", "recording")
            .put("liveLogoRequired", true).put("audioExpected", false));
        engine.vault.put("upload-queue", queue.toString());
        if (i != 0) engine.noteCaptureInterruption(sid, new CameraCapture.Interruption(
            CameraCapture.InterruptionCode.CAMERA_DISCONNECTED, "Camera disconnected."));
        assertThrows(RecordingAccuracy.Failure.class, () -> engine.saveFinalizedCapture(sid, file, 1000));
        LiveLogoEvidence.mark(file);
        JSONObject job = engine.saveFinalizedCapture(sid, file, i == 0 ? 1000 : -1);
        assertTrue(new Vault(fixture).array("upload-queue").getJSONObject(i).getBoolean("validationPending"));
        assertEquals(503, LocalVideoResponse.open(engine, file.getName(), null).getStatusCode());
        assertEquals(file, engine.localPlaybackFile(sid)); // A recovery export can still read the original bytes.
        actions.clear();
        requests.clear();
        savedDuration[0] = -1;
        try (var ticket = engine.backgroundTransfers.begin()) { upload.invoke(engine, job, ticket); }
        JSONObject updated = new Vault(fixture).array("upload-queue").getJSONObject(i);
        assertTrue(file.exists());
        assertFalse(actions.contains("upload"));
        if (i != 0) assertEquals("camera_disconnected", updated.getString("captureInterruptionCode"));
        for (JSONObject request : requests) {
          assertEquals(sid, request.getString("id"));
          if (i == 0) {
            assertFalse(request.has("capture_interruption_code"));
            assertFalse(request.has("capture_interrupted_at"));
          } else {
            assertEquals("camera_disconnected", request.getString("capture_interruption_code"));
            assertEquals(updated.getLong("captureInterruptedAt"), request.getLong("capture_interrupted_at"));
          }
        }
        if (i != 1) {
          assertEquals(List.of("captured", "saved"), actions);
          assertEquals("local_only", updated.getString("status"));
          assertFalse(updated.getBoolean("validationPending"));
          assertTrue(savedDuration[0] > 0 && savedDuration[0] < 60_000);
          assertEquals(updated.getLong("durationMs"), savedDuration[0]);
          try (InputStream preview = LocalVideoResponse.open(engine, file.getName(), null).getData()) {
            assertTrue(preview.read() >= 0);
          }
        } else {
          assertEquals(List.of("captured", "upload-failed"), actions);
          assertEquals("failed", updated.getString("status"));
          assertTrue(updated.getBoolean("validationFailed"));
          assertEquals(404, LocalVideoResponse.open(engine, file.getName(), null).getStatusCode());
          assertEquals(file, engine.localPlaybackFile(sid));
          engine.retryUpload(sid);
          assertEquals("failed", new Vault(fixture).array("upload-queue").getJSONObject(i).getString("status"));
        }
      }
    } finally {
      engine.work.shutdownNow();
      engine.uploads.shutdownNow();
      engine.exports.shutdownNow();
      engine.diagnostics.awaitWrites();
      for (File file : files) if (file != null) file.delete();
      new File(root, "recorder-diagnostics.json").delete();
      new File(root, "camera-test").delete();
      directory.delete();
      root.delete();
      fixture.getSharedPreferences("vault", 0).edit().clear().commit();
    }
  }

  private static void copySample(File file) throws IOException {
    try (InputStream sample = InstrumentationRegistry.getInstrumentation().getContext()
        .getAssets().open("recording-one-second.mp4");
        FileOutputStream out = new FileOutputStream(file)) {
      sample.transferTo(out);
    }
  }
}
