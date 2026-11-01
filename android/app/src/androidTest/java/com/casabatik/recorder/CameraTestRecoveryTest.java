package com.casabatik.recorder;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class CameraTestRecoveryTest {
  @Test public void staleConfirmationDoesNotTrapRecordAnotherTest() throws Exception {
    checkReviewRecovery(false);
  }

  @Test public void failedConfirmationKeepsTheClipAvailableForAnotherConfirmation() throws Exception {
    checkReviewRecovery(true);
  }

  private void checkReviewRecovery(boolean accepting) throws Exception {
    Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
    String namespace = "camera-review-test-" + UUID.randomUUID();
    File root = new File(base.getCacheDir(), namespace);
    assertTrue(root.mkdirs());
    Context context = new ContextWrapper(base) {
      public Context getApplicationContext() { return this; }
      public File getFilesDir() { return root; }
      public File getCacheDir() { return root; }
      public SharedPreferences getSharedPreferences(String name, int mode) {
        return base.getSharedPreferences(namespace + name, mode);
      }
    };
    Engine engine = new Engine(context, url -> new HttpURLConnection(url) {
      public void connect() {}
      public void disconnect() {}
      public boolean usingProxy() { return false; }
      public java.io.OutputStream getOutputStream() { return new ByteArrayOutputStream(); }
      public int getResponseCode() { return url.getPath().endsWith("/camera") ? 409 : 200; }
      public java.util.Map<String,java.util.List<String>> getHeaderFields() { return Collections.emptyMap(); }
      public java.io.InputStream getErrorStream() {
        return bytes("{\"error\":\"Camera settings changed during the test. Tap Record another test.\"}");
      }
      public java.io.InputStream getInputStream() {
        return bytes("{\"enabled\":true,\"device\":{\"video_device\":\"\"}}");
      }
      private ByteArrayInputStream bytes(String text) {
        return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8));
      }
    });
    engine.heartbeat.shutdownNow();
    try {
      engine.visible = true;
      engine.phase = "review";
      engine.cameraTestReady = true;
      engine.cameraTestRevision = UUID.randomUUID().toString();
      engine.cameraTestCamera = "{}";
      engine.vault.put("camera", "old camera");
      engine.vault.put("camera-revision", "old revision");
      engine.confirmCameraTest(accepting, !accepting);
      engine.work.submit(() -> {}).get(5, TimeUnit.SECONDS);
      assertFalse(engine.busy);
      assertEquals(accepting, engine.cameraTestReady);
      if (accepting) {
        assertEquals("review", engine.phase);
        assertTrue(engine.error.contains("Record another test"));
      } else {
        assertEquals("idle", engine.phase);
        assertTrue(engine.message.contains("choose"));
        assertEquals("", engine.vault.get("camera"));
        assertEquals("", engine.vault.get("camera-revision"));
      }
    } finally {
      engine.heartbeat.shutdownNow();
      engine.work.shutdownNow();
      engine.uploads.shutdownNow();
      context.getSharedPreferences("vault", 0).edit().clear().commit();
      new File(root, "camera-test").delete();
      root.delete();
    }
  }
}
