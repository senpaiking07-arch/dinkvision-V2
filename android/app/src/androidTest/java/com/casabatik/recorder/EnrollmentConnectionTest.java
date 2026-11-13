package com.casabatik.recorder;

import static org.junit.Assert.*;
import android.content.*;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.*;
import org.junit.Test;

/** Isolated transport failures; never enrolls or changes the real phone's registration. */
public class EnrollmentConnectionTest {
  private static final String TOKEN="A".repeat(43), REPLACEMENT="B".repeat(43);
  @Test public void qrEnrollmentAcceptsOnlyTheConfiguredOriginAndExactInviteFormat() {
    String invite = "Q".repeat(24);
    String link = Api.ORIGIN + "/tablet/enroll?invite=" + invite;
    assertEquals(invite, EnrollmentLink.scanned(link));
    assertEquals("", EnrollmentLink.scanned("https://unrelated.test/tablet/enroll?invite=" + invite));
    assertEquals("", EnrollmentLink.scanned(link + "&pin=123456"));
    assertEquals("", EnrollmentLink.scanned(link + "#something"));
    assertEquals("", EnrollmentLink.scanned(Api.ORIGIN + "/other?invite=" + invite));
    assertEquals(invite, EnrollmentLink.handoff(android.net.Uri.parse("dinkvision-recorder://enroll/" + invite)));
    assertEquals("", EnrollmentLink.handoff(android.net.Uri.parse("dinkvision-recorder://enroll/" + invite + "?pin=123456")));
    assertEquals("", EnrollmentLink.handoff(android.net.Uri.parse(link)));
    String pairing = "Abc012_de-Fg";
    String pairingLink = Api.ORIGIN + "/tablet/enroll#code=" + pairing;
    assertEquals(pairing, EnrollmentLink.scanned(pairingLink));
    assertEquals("", EnrollmentLink.scanned(pairingLink + "&replace=true"));
    assertEquals("", EnrollmentLink.scanned(link + "#code=" + pairing));
    String otherOrigin = "https://unrelated.test/tablet/enroll#code=" + pairing;
    assertEquals("", EnrollmentLink.scanned(otherOrigin));
    assertTrue(EnrollmentLink.forAnotherServer(otherOrigin));
    assertFalse(EnrollmentLink.forAnotherServer(pairingLink));
    assertFalse(EnrollmentLink.forAnotherServer("https://unrelated.test/other#code=" + pairing));
    assertEquals(pairing, EnrollmentLink.handoff(android.net.Uri.parse("dinkvision-recorder://enroll/" + pairing)));
  }

  @Test public void responseAcceptedBeforeEnrollmentCannotApplyOldStateAfterEnrollment() throws Exception {
    try(Fixture f=new Fixture()) {
      Api api=new Api(f.vault,f.transport);
      JSONObject old=api.call("/api/tablet",null);
      f.cookie="cb-kiosk="+REPLACEMENT+"; Max-Age=15552000";f.response="{\"ok\":true}";
      api.call("/api/tablet/enroll",new JSONObject());
      AtomicInteger applied=new AtomicInteger();
      assertThrows(Exception.class,()->api.acceptCurrentResponse(old,applied::incrementAndGet));
      assertEquals(0,applied.get());
      JSONObject fresh=api.call("/api/tablet",null);
      api.acceptCurrentResponse(fresh,applied::incrementAndGet);
      assertEquals(1,applied.get());
      assertFalse("Credential metadata must never become JSON/UI output",fresh.toString().contains(REPLACEMENT));
    }
  }

  @Test public void startReconcilesOnlyTheActualCaptureHolder() throws Exception {
    try(Fixture f=new Fixture()) {
      List<String> released=new ArrayList<>();
      Engine engine=new Engine(f.context,url->new HttpURLConnection(url) {
        final ByteArrayOutputStream body=new ByteArrayOutputStream();
        public void connect(){}public void disconnect(){}public boolean usingProxy(){return false;}
        public OutputStream getOutputStream(){return body;}
        public int getResponseCode() {
          try {JSONObject request=new JSONObject(body.toString("UTF-8"));
            if("captured".equals(request.optString("action")))released.add(request.getString("id"));
          }catch(Exception ignored){}return 200;
        }
        public InputStream getInputStream(){return new ByteArrayInputStream("{}".getBytes(StandardCharsets.UTF_8));}
        public Map<String,List<String>> getHeaderFields(){return Map.of();}
      });
      engine.heartbeat.shutdownNow();
      File directory=new File(f.root,"recordings");directory.mkdirs();
      JSONArray jobs=new JSONArray();List<File> files=new ArrayList<>();
      try {
        for(int i=0;i<10;i++) {
          String id=UUID.randomUUID().toString();File file=new File(directory,id+".mp4");files.add(file);
          try(FileOutputStream out=new FileOutputStream(file)){out.write(new byte[2048]);}
          jobs.put(new JSONObject().put("id",id).put("device","device").put("status","pending").put("localAvailable",true));
        }
        engine.server = new JSONObject().put("device", new JSONObject().put("id", "device"));
        for (int depth : new int[]{0, 1, 5, 10}) {
          JSONArray queued = new JSONArray();
          for (int index = 0; index < depth; index++) {
            JSONObject item = jobs.getJSONObject(index);
            if (index == 0) item.put("status", "retrying").put("nextRetryAt", Long.MAX_VALUE);
            if (index == 1) item.put("status", "failed").put("retryCount", 8);
            if (index == 2) item.put("localAvailable", false);
            queued.put(item);
          }
          engine.vault.put("upload-queue", queued.toString());
          long start = System.nanoTime();
          for (int iteration = 0; iteration < 100; iteration++) engine.releaseBlockingCapture();
          long micros = TimeUnit.NANOSECONDS.toMicros(System.nanoTime() - start);
          System.out.println("Capture reservation reconciliation, depth=" + depth + ", 100 calls=" + micros + " us");
          assertTrue("Historical jobs must add no capture-start network work at depth " + depth, released.isEmpty());
        }
        String blocker=jobs.getJSONObject(7).getString("id");
        engine.server.put("session",new JSONObject().put("id",blocker).put("status","recording"));
        engine.releaseBlockingCapture();
        assertEquals(List.of(blocker),released);
        engine.server.put("session",new JSONObject().put("id",UUID.randomUUID().toString()).put("status","recording"));
        engine.releaseBlockingCapture();
        assertEquals("Unknown capture must not be force-closed",1,released.size());
      }finally{
        engine.work.shutdownNow();engine.uploads.shutdownNow();engine.exports.shutdownNow();
        for(File file:files)file.delete();directory.delete();
      }
    }
  }

  private static HttpURLConnection response(URL url, CountDownLatch entered, CountDownLatch release, String cookie) {
    return new HttpURLConnection(url) {
      public void connect(){} public void disconnect(){} public boolean usingProxy(){return false;}
      public OutputStream getOutputStream(){return new ByteArrayOutputStream();}
      public int getResponseCode() throws IOException {
        if (entered != null) entered.countDown();
        try { if (release != null && !release.await(5, TimeUnit.SECONDS)) throw new IOException("Test timed out"); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException(e); }
        return 200;
      }
      public InputStream getInputStream(){return new ByteArrayInputStream("{\"ok\":true}".getBytes(StandardCharsets.UTF_8));}
      public Map<String,List<String>> getHeaderFields(){return cookie.isEmpty()?Map.of():Map.of("Set-Cookie",List.of(cookie));}
    };
  }

  @Test public void slowBackgroundMetadataDoesNotBlockCaptureControl() throws Exception {
    try (Fixture f = new Fixture()) {
      CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
      ExecutorService workers = Executors.newFixedThreadPool(2);
      Api api = new Api(f.vault, url -> response(url, url.getPath().endsWith("/slow") ? entered : null,
          url.getPath().endsWith("/slow") ? release : null, ""));
      try {
        Future<?> slow = workers.submit(() -> { try { api.call("/api/slow", null); } catch (Exception e) { throw new RuntimeException(e); } });
        assertTrue(entered.await(2, TimeUnit.SECONDS));
        Future<JSONObject> capture = workers.submit(() -> api.tablet("start", new JSONObject()));
        assertTrue("Capture must complete while the background response is still held", capture.get(1, TimeUnit.SECONDS).getBoolean("ok"));
        release.countDown(); slow.get(2, TimeUnit.SECONDS);
      } finally { release.countDown(); workers.shutdownNow(); }
    }
  }

  @Test public void oldResponseCannotOverwriteNewEnrollmentOrReturnOldDeviceState() throws Exception {
    try (Fixture f = new Fixture()) {
      CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
      ExecutorService workers = Executors.newFixedThreadPool(2);
      Api api = new Api(f.vault, url -> response(url, url.getPath().endsWith("/slow") ? entered : null,
          url.getPath().endsWith("/slow") ? release : null,
          url.getPath().endsWith("/enroll") ? "cb-kiosk="+REPLACEMENT+"; Max-Age=15552000" : "other=value"));
      try {
        Future<Boolean> old = workers.submit(() -> {
          try { api.call("/api/slow", null); return false; }
          catch (Exception expected) { return expected.getMessage().contains("registration changed"); }
        });
        assertTrue(entered.await(2, TimeUnit.SECONDS));
        workers.submit(() -> api.call("/api/tablet/enroll", new JSONObject())).get(1, TimeUnit.SECONDS);
        release.countDown();
        assertTrue("Discard state returned for the previous enrollment", old.get(2, TimeUnit.SECONDS));
        assertEquals(REPLACEMENT, f.vault.object("cookies").getString("cb-kiosk"));
        assertFalse(f.vault.object("cookies").has("other"));
      } finally { release.countDown(); workers.shutdownNow(); }
    }
  }
  private static final class Fixture implements AutoCloseable {
    final Context base=InstrumentationRegistry.getInstrumentation().getTargetContext();
    final String namespace="enrollment-network-"+UUID.randomUUID();
    final File root=new File(base.getCacheDir(),namespace);
    final Context context=new ContextWrapper(base){
      public Context getApplicationContext(){return this;}
      public File getFilesDir(){return root;}
      public File getCacheDir(){return root;}
      public SharedPreferences getSharedPreferences(String name,int mode){return base.getSharedPreferences(namespace+name,mode);}
    };
    final Vault vault=new Vault(context);
    int status=200;String response="{\"enabled\":true,\"device\":{\"id\":\"device\"}}",cookie="";
    boolean offline;String requestCookie="";final AtomicInteger enrollments=new AtomicInteger();
    final Api.Connections transport=url->{
      if(url.getPath().equals("/api/tablet/enroll"))enrollments.incrementAndGet();
      return new HttpURLConnection(url){
        public void connect(){}public void disconnect(){}public boolean usingProxy(){return false;}
        public OutputStream getOutputStream(){return new ByteArrayOutputStream();}
        public int getResponseCode() throws IOException {
          requestCookie=getRequestProperty("Cookie");
          if(offline)throw new SocketTimeoutException("Simulated internet outage");
          return status;
        }
        public Map<String,List<String>> getHeaderFields(){return cookie.isEmpty()?Map.of():Map.of("Set-Cookie",List.of(cookie));}
        public InputStream getInputStream(){return new ByteArrayInputStream(response.getBytes(StandardCharsets.UTF_8));}
        public InputStream getErrorStream(){return getInputStream();}
      };
    };
    Fixture() throws Exception {assertTrue(root.mkdirs());vault.put("cookies",new JSONObject().put("cb-kiosk",TOKEN).toString());vault.put("device-id","device");}
    public void close(){context.getSharedPreferences("vault",0).edit().clear().commit();new File(root,"camera-test/clip.mp4").delete();new File(root,"camera-test").delete();root.delete();}
  }

  @Test public void tabletPairingKeepsExistingCookieUntilAConfirmedClaim() throws Exception {
    try (Fixture f = new Fixture()) {
      Api api = new Api(f.vault, f.transport);
      f.response = "{\"status\":\"pending\"}";
      f.cookie = "cb-kiosk=" + REPLACEMENT + "; Max-Age=3600; Path=/";
      api.call("/api/tablet/pairing", new JSONObject());
      assertEquals(TOKEN, f.vault.object("cookies").getString("cb-kiosk"));
      f.response = "{\"status\":\"enrolled\",\"ok\":true}";
      f.cookie = "";
      assertThrows(Exception.class, () -> api.call("/api/tablet/pairing", new JSONObject()));
      assertEquals(TOKEN, f.vault.object("cookies").getString("cb-kiosk"));
      f.cookie = "cb-kiosk=" + REPLACEMENT + "; Max-Age=3600; Path=/";
      api.call("/api/tablet/pairing", new JSONObject());
      assertEquals(REPLACEMENT, f.vault.object("cookies").getString("cb-kiosk"));
    }
  }

  @Test public void longOutageAndProcessReloadReuseTheOriginalRegistration() throws Exception {
    try(Fixture f=new Fixture()){
      Api api=new Api(f.vault,f.transport);f.offline=true;
      for(int n=0;n<20;n++){
        assertThrows(Exception.class,()->api.call("/api/tablet",null));
        assertEquals(TOKEN,new Vault(f.context).object("cookies").getString("cb-kiosk"));
      }
      f.offline=false;Api reopened=new Api(new Vault(f.context),f.transport);
      assertTrue(reopened.call("/api/tablet",null).getBoolean("enabled"));
      assertEquals("cb-kiosk="+TOKEN,f.requestCookie);assertEquals(0,f.enrollments.get());
    }
  }

  @Test public void aRejectedCodeDoesNotLeaveConfirmationPending() throws Exception {
    try (Fixture f = new Fixture()) {
      f.status = 400;
      f.response = "{\"error\":\"Enter the full enrollment code from your administrator.\"}";
      Engine engine = new Engine(f.context, f.transport);
      engine.heartbeat.shutdownNow();
      try {
        engine.enroll("E".repeat(12), true);
        engine.work.submit(() -> {}).get(4, TimeUnit.SECONDS);
        assertFalse(new JSONObject(engine.snapshot()).getBoolean("enrollmentPending"));
        assertEquals(TOKEN, engine.vault.object("cookies").getString("cb-kiosk"));
        assertTrue(engine.error.contains("same Admin site"));
      } finally {
        engine.work.shutdownNow(); engine.uploads.shutdownNow(); engine.exports.shutdownNow();
      }
    }
  }

  @Test public void aLostEnrollmentReplyRecoversTheCommittedCredentialAfterRestart() throws Exception {
    try (Fixture f = new Fixture()) {
      List<JSONObject> enrollments = new ArrayList<>();
      String code = "E".repeat(24);
      Api.Connections transport = url -> new HttpURLConnection(url) {
        final ByteArrayOutputStream body = new ByteArrayOutputStream();
        boolean recovery;
        public void connect() {}
        public void disconnect() {}
        public boolean usingProxy() { return false; }
        public OutputStream getOutputStream() { return body; }
        public int getResponseCode() throws IOException {
          if (url.getPath().equals("/api/tablet/enroll")) {
            try {
              JSONObject request = new JSONObject(body.toString("UTF-8"));
              enrollments.add(request);
              recovery = request.optBoolean("recover");
            } catch (JSONException invalid) { throw new AssertionError(invalid); }
            if (!recovery) throw new SocketTimeoutException("Committed response was lost");
          }
          return 200;
        }
        public InputStream getInputStream() {
          String response = recovery ? "{\"ok\":true}" :
              REPLACEMENT.equals(getRequestProperty("Cookie").replace("cb-kiosk=", ""))
                  ? "{\"enabled\":true,\"device\":{\"id\":\"device\"}}"
                  : "{\"enabled\":false,\"capabilities\":{\"enrollmentRecovery\":true}}";
          return new ByteArrayInputStream(response.getBytes(StandardCharsets.UTF_8));
        }
        public Map<String, List<String>> getHeaderFields() {
          return recovery ? Map.of("Set-Cookie", List.of("cb-kiosk=" + REPLACEMENT + "; Max-Age=15552000")) : Map.of();
        }
      };
      Engine first = new Engine(f.context, transport);
      first.heartbeat.shutdownNow();
      try {
        first.enroll(code, true);
        first.work.submit(() -> {}).get(4, TimeUnit.SECONDS);
        assertTrue(first.error.contains("Connection interrupted"));
        assertEquals(TOKEN, new Vault(f.context).object("cookies").getString("cb-kiosk"));
        JSONObject attempt = new Vault(f.context).object("pending-enrollment");
        assertEquals(code, attempt.getString("code"));
        assertTrue(attempt.getString("attempt").matches("[A-Za-z0-9_-]{43}"));
        assertFalse(first.snapshot().contains(attempt.getString("attempt")));
      } finally {
        first.work.shutdownNow(); first.uploads.shutdownNow(); first.exports.shutdownNow();
      }
      Engine reopened = new Engine(f.context, transport);
      reopened.heartbeat.shutdownNow();
      try {
        reopened.refresh();
        assertEquals(2, enrollments.size());
        assertFalse(enrollments.get(0).optBoolean("recover"));
        assertTrue(enrollments.get(1).getBoolean("recover"));
        assertEquals(enrollments.get(0).getString("attempt"), enrollments.get(1).getString("attempt"));
        assertTrue(reopened.server.getBoolean("enabled"));
        assertEquals("device", reopened.vault.get("device-id"));
        assertEquals(REPLACEMENT, reopened.vault.object("cookies").getString("cb-kiosk"));
        assertEquals("", new Vault(f.context).get("pending-enrollment"));
        reopened.refresh();
        assertEquals(2, enrollments.size());
      } finally {
        reopened.work.shutdownNow(); reopened.uploads.shutdownNow(); reopened.exports.shutdownNow();
      }
    }
  }

  @Test public void failedOrMalformedHostedResponsesCannotEraseEnrollment() throws Exception {
    try(Fixture f=new Fixture()){
      Api api=new Api(f.vault,f.transport);
      for(int status:new int[]{502,503,504,401,307,200}){
        f.status=status;f.cookie="cb-kiosk=; Max-Age=0; Path=/; Secure; HttpOnly";
        f.response=status==200?"<html>Deployment unavailable</html>":"{\"error\":\"Temporary failure\"}";
        assertThrows(Exception.class,()->api.call("/api/tablet",null));
        assertEquals("A failed response must not erase pairing",TOKEN,f.vault.object("cookies").optString("cb-kiosk"));
      }
    }
  }

  @Test public void onlySuccessfulEnrollmentCanReplaceTheDeviceCredential() throws Exception {
    try(Fixture f=new Fixture()){
      Api api=new Api(f.vault,f.transport);
      f.cookie="cb-kiosk="+REPLACEMENT+"; Max-Age=15552000; Secure; HttpOnly";
      api.call("/api/tablet",null);
      assertEquals("A normal state poll cannot rotate registration",TOKEN,f.vault.object("cookies").getString("cb-kiosk"));
      f.response="{\"ok\":true}";api.call("/api/tablet/enroll",new JSONObject().put("code","synthetic-test-code"));
      assertEquals(REPLACEMENT,new Vault(f.context).object("cookies").getString("cb-kiosk"));
      assertEquals(1,f.enrollments.get());
    }
  }

  @Test public void automaticReconnectClearsOnlyItsOwnConnectionError() throws Exception {
    try(Fixture f=new Fixture()){
      Engine e=new Engine(f.context,f.transport);e.heartbeat.shutdownNow();
      try {
        f.offline=true;e.refresh();assertTrue(e.error.contains("Connection interrupted"));assertFalse(e.error.contains("outage"));assertTrue(e.hasStoredEnrollment());
        f.offline=false;e.refresh();assertEquals("",e.error);assertTrue(e.server.getBoolean("enabled"));
        f.offline=true;e.refresh();e.error="USB camera was disconnected.";
        f.offline=false;e.refresh();assertEquals("USB camera was disconnected.",e.error);
        assertEquals(TOKEN,e.vault.object("cookies").getString("cb-kiosk"));assertEquals(0,f.enrollments.get());
      } finally {e.heartbeat.shutdownNow();e.work.shutdownNow();e.uploads.shutdownNow();e.exports.shutdownNow();}
    }
  }

  @Test public void invalidAssignmentOrMissingNewCookiePreservesOwnerAndCredential() throws Exception {
    try (Fixture f = new Fixture()) {
      Engine e = new Engine(f.context, f.transport);
      e.heartbeat.shutdownNow();
      try {
        e.refresh();
        for (String invalid : new String[]{"{}", "{\"enabled\":\"false\"}", "{\"enabled\":true}"}) {
          f.response = invalid;
          e.refresh();
          assertTrue(e.server.getBoolean("enabled"));
          assertEquals("device", e.vault.get("device-id"));
          assertTrue(new JSONObject(e.snapshot()).getBoolean("connectionRetry"));
        }
        f.response = "{\"ok\":true}";
        assertThrows(Exception.class, () -> e.api.call("/api/tablet/enroll", new JSONObject()));
        assertEquals(TOKEN, new Vault(f.context).object("cookies").getString("cb-kiosk"));
      } finally { e.work.shutdownNow(); e.uploads.shutdownNow(); e.exports.shutdownNow(); }
    }
  }

  @Test public void aRevokedRegistrationIsStillRejectedWithoutErasingLocalCredentials() throws Exception {
    try(Fixture f=new Fixture()){
      f.response="{\"enabled\":false}";f.cookie="cb-kiosk=; Max-Age=0";
      Engine e=new Engine(f.context,f.transport);e.heartbeat.shutdownNow();
      try{
        e.refresh();assertTrue(e.initialized);assertFalse(e.server.getBoolean("enabled"));
        assertTrue(e.hasStoredEnrollment());assertEquals(TOKEN,e.vault.object("cookies").getString("cb-kiosk"));
        assertEquals(0,f.enrollments.get());
      }finally{e.heartbeat.shutdownNow();e.work.shutdownNow();e.uploads.shutdownNow();e.exports.shutdownNow();}
    }
  }
}
