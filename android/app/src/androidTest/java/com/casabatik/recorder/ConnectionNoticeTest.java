package com.casabatik.recorder;

import static org.junit.Assert.*;
import org.junit.Test;

public class ConnectionNoticeTest {
  @Test public void existingApiRequestsDetectTransportLossAndVerifiedRecovery() throws Exception {
    var offline = new java.util.concurrent.atomic.AtomicBoolean(true);
    var context = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().getTargetContext();
    Api api = new Api(new Vault(context), url -> {
      if (offline.get()) throw new java.net.ConnectException("Fixture server unreachable");
      return new java.net.HttpURLConnection(url) {
        public void connect() {} public void disconnect() {} public boolean usingProxy(){return false;}
        public int getResponseCode(){return 200;}
        public java.io.InputStream getInputStream(){return new java.io.ByteArrayInputStream("{}".getBytes(java.nio.charset.StandardCharsets.UTF_8));}
        public java.util.Map<String,java.util.List<String>> getHeaderFields(){return java.util.Collections.emptyMap();}
      };
    });
    try { api.call("/api/tablet",null); fail("Expected fixture outage"); } catch(java.io.IOException expected) {}
    assertEquals(Boolean.FALSE,api.serverReachable);
    offline.set(false);api.call("/api/tablet",null);
    assertEquals(Boolean.TRUE,api.serverReachable);
  }
  @Test public void distinguishesInternetFromServerAndClearsAfterRecovery() {
    assertTrue(ConnectionNotice.message(false, false).startsWith("No internet"));
    assertTrue(ConnectionNotice.message(false, true).startsWith("No internet"));
    assertTrue(ConnectionNotice.message(true, false).startsWith("Internet available"));
    assertEquals("", ConnectionNotice.message(true, true));
    assertEquals("", ConnectionNotice.message(true, null));
  }
}
