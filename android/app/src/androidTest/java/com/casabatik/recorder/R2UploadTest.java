package com.casabatik.recorder;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.net.HttpURLConnection;
import java.util.*;
import org.json.JSONObject;
import org.junit.Test;

public class R2UploadTest {
  @Test public void multipartUsesEightMiBPartsAndWaitsForServerConfirmation() throws Exception {
    long size = 8L * 1024 * 1024 + 19;
    List<Integer> chunks = new ArrayList<>();
    long[] offset = {0};
    boolean[] confirmed = {false};
    UploadTransfer.send(size, new UploadTransfer.Transport() {
      public JSONObject action(String action) throws Exception {
        if (action.equals("upload")) return new JSONObject().put("upload",new JSONObject()
            .put("protocol","r2-multipart-v1").put("partSize",8*1024*1024).put("bytes",size).put("parallelism",1));
        if (action.equals("upload-status")) return offset[0] == size ? new JSONObject().put("uploaded",true)
            : new JSONObject().put("offset",offset[0]);
        assertEquals("finish",action);confirmed[0]=true;return new JSONObject().put("ready",true);
      }
      public JSONObject chunk(long start,int length) throws Exception {
        assertEquals(offset[0],start);chunks.add(length);offset[0]+=length;
        return new JSONObject().put("accepted",true);
      }
      public List<UploadTransfer.PartGrant> grants(long offset, int count, int partSize, long total) {
        return List.of(new UploadTransfer.PartGrant((int) (offset / partSize) + 1,
            offset, (int) Math.min(partSize, total - offset), ""));
      }
    },percent->{if(percent==100)assertTrue(confirmed[0]);});
    assertEquals(List.of(8*1024*1024,19),chunks);
  }

  @Test public void directR2PartsStreamOnlyRequestedBytesWithoutApplicationCredentials() throws Exception {
    Context base=InstrumentationRegistry.getInstrumentation().getTargetContext();
    String name="r2-upload-test-"+UUID.randomUUID();
    Context context=new ContextWrapper(base) {
      public Context getApplicationContext(){return this;}
      public SharedPreferences getSharedPreferences(String ignored,int mode){return base.getSharedPreferences(name,mode);}
    };
    File file=new File(base.getCacheDir(),name+".mp4");
    try {
      try(FileOutputStream out=new FileOutputStream(file)){out.write(new byte[]{1,2,3,4,5});}
      Vault vault=new Vault(context);vault.put("cookies","{\"cb-kiosk\":\"fixture\"}");
      ByteArrayOutputStream bytes=new ByteArrayOutputStream();
      int[] fixtureStatus = {200};
      HttpURLConnection[] connection=new HttpURLConnection[1];
      Api api=new Api(vault,url->connection[0]=new HttpURLConnection(url){
        public void connect(){}public void disconnect(){}public boolean usingProxy(){return false;}
        public OutputStream getOutputStream(){return bytes;}public int getResponseCode(){return fixtureStatus[0];}
      });
      String address="https://42c7c9ce788292c080caf0ad3e8daded.r2.cloudflarestorage.com/bucket/key?uploadId=id&partNumber=1&X-Amz-Signature=fixture";
      for (int status : new int[] {200, 400, 403}) {
        fixtureStatus[0] = status;
        api.checkStorageHost(address);
        assertEquals("HEAD", connection[0].getRequestMethod());
        assertEquals("/", connection[0].getURL().getFile());
        assertNull(connection[0].getRequestProperty("Cookie"));
        assertFalse(connection[0].getInstanceFollowRedirects());
      }
      Api offline = new Api(vault, url -> { throw new java.net.UnknownHostException("private detail"); });
      Api.RequestFailure probe = assertThrows(Api.RequestFailure.class, () -> offline.checkStorageHost(address));
      assertEquals("dns", probe.code);
      assertTrue(probe.getMessage().contains("unreachable from this network"));
      assertFalse(probe.getMessage().contains("Signature"));
      assertFalse(probe.getMessage().contains("private detail"));
      assertEquals(60000, Api.readTimeout("/api/tablet", new JSONObject().put("action","upload-parts")));
      assertEquals(30000, Api.readTimeout("/api/tablet", new JSONObject().put("action","heartbeat")));
      fixtureStatus[0] = 200;
      assertTrue(api.uploadR2Part(address,file,2,3).getBoolean("accepted"));
      assertEquals(180000, connection[0].getReadTimeout());
      assertArrayEquals(new byte[]{3,4,5},bytes.toByteArray());
      assertNull(connection[0].getRequestProperty("Cookie"));
      assertNull(connection[0].getRequestProperty("Authorization"));
      assertNull(connection[0].getRequestProperty("Origin"));
      assertNull(connection[0].getRequestProperty("Content-Range"));
      assertFalse(connection[0].getInstanceFollowRedirects());
      for (int code : new int[]{403, 404, 410}) {
        fixtureStatus[0] = code;
        assertTrue(api.uploadR2Part(address, file, 2, 3).getBoolean("expired"));
      }
      for (int code : new int[]{429, 503}) {
        fixtureStatus[0] = code;
        assertEquals(code, assertThrows(Api.RequestFailure.class,
            () -> api.uploadR2Part(address, file, 2, 3)).httpStatus);
      }
      assertThrows(Exception.class,()->api.uploadR2Part(address.replace("cloudflarestorage.com","evil.invalid"),file,0,5));
    } finally {file.delete();base.getSharedPreferences(name,0).edit().clear().commit();}
  }
}
