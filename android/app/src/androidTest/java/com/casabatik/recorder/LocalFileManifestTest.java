package com.casabatik.recorder;

import static org.junit.Assert.*;
import android.content.*;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import org.json.*;
import org.junit.Test;

public class LocalFileManifestTest {
  @Test public void freshJournalReconcilesOnlyOwnedInactiveServerFilesAndDurablyReportsAbsence() throws Exception {
    Context base=InstrumentationRegistry.getInstrumentation().getTargetContext();
    String namespace="manifest-test-"+UUID.randomUUID(), device=UUID.randomUUID().toString();
    File root=new File(base.getCacheDir(),namespace), directory=new File(root,"recordings");
    assertTrue(directory.mkdirs());
    Context context=new ContextWrapper(base){
      public Context getApplicationContext(){return this;}
      public File getFilesDir(){return root;}
      public SharedPreferences getSharedPreferences(String name,int mode){return base.getSharedPreferences(namespace+name,mode);}
    };
    AtomicReference<JSONObject> report=new AtomicReference<>();
    String missing=UUID.randomUUID().toString(), active=UUID.randomUUID().toString(), present=UUID.randomUUID().toString();
    File original=new File(directory,present+".mp4");
    try(FileOutputStream out=new FileOutputStream(original)){out.write(new byte[2048]);}
    Engine engine=new Engine(context,url->new HttpURLConnection(url){
      final ByteArrayOutputStream body=new ByteArrayOutputStream();
      public void connect(){}public void disconnect(){}public boolean usingProxy(){return false;}
      public OutputStream getOutputStream(){return body;}
      public int getResponseCode(){return 200;}
      public Map<String,List<String>> getHeaderFields(){return Collections.emptyMap();}
      public InputStream getInputStream() throws IOException {
        try {report.set(new JSONObject(body.toString(StandardCharsets.UTF_8.name())));}catch(Exception e){throw new IOException(e);}
        return new ByteArrayInputStream("{\"ok\":true}".getBytes(StandardCharsets.UTF_8));
      }
    });
    engine.heartbeat.shutdownNow();
    try {
      JSONArray manifest=new JSONArray();
      for(String id:new String[]{missing,active,present})manifest.put(new JSONObject().put("session_id",id)
          .put("local_available",true).put("upload_state","local_only").put("branding_state","complete")
          .put("client_created_at","2026-11-02T00:00:00Z").put("duration_ms",8000)
          .put("recording_sessions",new JSONObject().put("status",id.equals(active)?"recording":"ready")
              .put("recipient_emails",new JSONArray().put("fixture@gmail.com"))));
      engine.updateServer(new JSONObject().put("enabled",true).put("device",new JSONObject().put("id",device)).put("queue",manifest));
      JSONArray queue=engine.vault.array("upload-queue");JSONObject absent=null,restored=null;
      for(int i=0;i<queue.length();i++){
        JSONObject item=queue.getJSONObject(i);assertNotEquals("Active capture must not be inferred missing",active,item.getString("id"));
        if(item.getString("id").equals(missing))absent=item;
        if(item.getString("id").equals(present))restored=item;
      }
      assertNotNull(absent);assertFalse(absent.getBoolean("localAvailable"));assertTrue(absent.getBoolean("presenceReportPending"));
      assertNotNull(restored);assertEquals(device,restored.getString("device"));assertTrue(restored.getBoolean("localAvailable"));
      assertEquals("local_only",restored.getString("status"));assertEquals("fixture@gmail.com",restored.getJSONArray("recipients").getString(0));
      assertEquals(2048,original.length());
      engine.reportFilePresence();assertNotNull(report.get());assertEquals(missing,report.get().getString("id"));
      assertFalse(report.get().getBoolean("local_available"));assertEquals("queue-report",report.get().getString("action"));
      report.set(null);engine.reportFilePresence();assertNull("Acknowledged presence must not be reported endlessly",report.get());
      JSONArray journal=engine.vault.array("upload-queue");
      for(int i=0;i<journal.length();i++)if(journal.getJSONObject(i).optString("id").equals(present))
        journal.getJSONObject(i).put("exportReportPending",true).put("exportedAt",1234).put("exportedBytes",2048);
      engine.vault.put("upload-queue",journal.toString());
      engine.reportDeviceCopies();assertNull("Older backends must not receive unsupported copy actions",report.get());
      engine.server.put("capabilities",new JSONObject().put("deviceCopyReporting",true));
      engine.reportDeviceCopies();assertEquals("device-copy",report.get().getString("action"));assertEquals(2048,report.get().getLong("bytes"));
      report.set(null);engine.reportDeviceCopies();assertNull("Acknowledged exports are idempotent",report.get());
      JSONObject stale=new JSONObject(restored.toString());
      var save=Engine.class.getDeclaredMethod("saveQueueItem",JSONObject.class);save.setAccessible(true);
      save.invoke(engine,stale.put("status","uploading"));
      JSONObject saved=null;
      for(int i=0;i<engine.vault.array("upload-queue").length();i++){
        JSONObject candidate=engine.vault.array("upload-queue").getJSONObject(i);
        if(candidate.optString("id").equals(present))saved=candidate;
      }
      assertEquals("A concurrent upload must not erase a completed device-copy receipt",1234,saved.getLong("exportedAt"));
      assertFalse("A stale upload must not reset an acknowledged receipt",saved.getBoolean("exportReportPending"));
      engine.vault.put("cookies",new JSONObject().put("cb-kiosk","existing-device-credential").toString());
      engine.enroll("new-code",false);
      assertTrue(engine.error.contains("already registered"));assertFalse(engine.busy);
      assertEquals("existing-device-credential",engine.vault.object("cookies").getString("cb-kiosk"));assertNull(report.get());
    } finally {
      engine.heartbeat.shutdownNow();engine.work.shutdownNow();engine.uploads.shutdownNow();engine.exports.shutdownNow();
      original.delete();directory.delete();root.delete();context.getSharedPreferences("vault",0).edit().clear().commit();
    }
  }
}
