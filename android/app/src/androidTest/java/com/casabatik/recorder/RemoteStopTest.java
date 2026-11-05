package com.casabatik.recorder;

import static org.junit.Assert.*;
import android.content.*;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;
import org.junit.Test;

public class RemoteStopTest {
  @Test public void recordingPollsAndHonorsOnlyItsOwnAdminStop() throws Exception {
    Context base=InstrumentationRegistry.getInstrumentation().getTargetContext();
    String namespace="remote-stop-"+UUID.randomUUID(), device=UUID.randomUUID().toString(), session=UUID.randomUUID().toString();
    Context context=new ContextWrapper(base){
      public Context getApplicationContext(){return this;}
      public SharedPreferences getSharedPreferences(String name,int mode){return base.getSharedPreferences(namespace+name,mode);}
    };
    CountDownLatch polled=new CountDownLatch(1);
    JSONObject state=new JSONObject().put("enabled",true).put("device",new JSONObject().put("id",device))
        .put("session",new JSONObject().put("id",session).put("status","recording").put("stop_requested_at","2026-11-02T00:00:00Z"));
    Engine engine=new Engine(context,url->new HttpURLConnection(url){
      public void connect(){}public void disconnect(){}public boolean usingProxy(){return false;}
      public OutputStream getOutputStream(){return new ByteArrayOutputStream();}
      public int getResponseCode(){return "GET".equals(getRequestMethod())?200:503;}
      public InputStream getErrorStream(){return new ByteArrayInputStream("{\"error\":\"Controlled heartbeat/report outage\"}".getBytes(StandardCharsets.UTF_8));}
      public Map<String,List<String>> getHeaderFields(){return Collections.emptyMap();}
      public InputStream getInputStream(){
        boolean get="GET".equals(getRequestMethod());if(get)polled.countDown();
        return new ByteArrayInputStream((get?state.toString():"{\"ok\":true}").getBytes(StandardCharsets.UTF_8));
      }
    });
    try {
      engine.busy=true;engine.phase="recording";engine.activeSession=session;
      engine.updateServer(new JSONObject(state.toString()).put("session",new JSONObject().put("id",UUID.randomUUID().toString()).put("stop_requested_at","2026-11-02T00:00:00Z")));
      assertFalse("An unrelated session cannot stop this camera",engine.stop);
      engine.updateServer(new JSONObject(state.toString()).put("session",new JSONObject().put("id",session).put("status","recording").put("stop_requested_at",JSONObject.NULL)));
      assertFalse("A null stop request must leave recording running",engine.stop);
      assertTrue("Admin commands must be polled while recording",polled.await(4,TimeUnit.SECONDS));
      long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(1);
      while(!engine.stop&&System.nanoTime()<end)Thread.sleep(10);
      assertTrue("The matching Admin stop request must reach the capture loop",engine.stop);
      engine.updateServer(state);assertTrue("Repeated stop requests remain idempotent",engine.stop);
    } finally {
      engine.busy=false;engine.heartbeat.shutdownNow();engine.work.shutdownNow();engine.uploads.shutdownNow();engine.exports.shutdownNow();
      context.getSharedPreferences("vault",0).edit().clear().commit();
    }
  }
}
