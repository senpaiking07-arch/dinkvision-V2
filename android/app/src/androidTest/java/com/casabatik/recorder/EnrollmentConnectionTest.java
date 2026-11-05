package com.casabatik.recorder;

import static org.junit.Assert.*;
import android.content.*;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.*;
import org.junit.Test;

/** Isolated transport failures; never enrolls or changes the real phone's registration. */
public class EnrollmentConnectionTest {
  private static final String TOKEN="A".repeat(43), REPLACEMENT="B".repeat(43);
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
        f.offline=true;e.refresh();assertTrue(e.error.contains("outage"));assertTrue(e.hasStoredEnrollment());
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
