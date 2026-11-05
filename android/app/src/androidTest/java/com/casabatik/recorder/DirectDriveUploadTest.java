package com.casabatik.recorder;

import static org.junit.Assert.*;
import android.content.*;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.*;
import org.junit.Test;

/** Exercises the real upload loop with isolated preferences/files and fake cloud transport. */
public class DirectDriveUploadTest {
  static final String SESSION="12345678-1234-1234-1234-123456789abc";
  static final String ADDRESS="https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=fixture-only";
  static final class Fixture implements AutoCloseable {
    final Context base=InstrumentationRegistry.getInstrumentation().getTargetContext();
    final String name="direct-drive-"+UUID.randomUUID();
    final Context context=new ContextWrapper(base){
      public Context getApplicationContext(){return this;}
      public SharedPreferences getSharedPreferences(String n,int mode){return base.getSharedPreferences(name,mode);}
    };
    final File file=new File(base.getCacheDir(),name+".mp4");
    final Vault vault=new Vault(context);
    final List<Long> ranges=new ArrayList<>();
    final List<String> destinations=new ArrayList<>();
    long offset;int chunks,restarts,finishes,applicationBytes;
    boolean loseResponse,expire,confirm=true,omitGrant;
    int driveStatus=0;String grantAddress=ADDRESS;long grantBytes=-1;
    final Api.Connections connections=url->new HttpURLConnection(url){
      final ByteArrayOutputStream body=new ByteArrayOutputStream();
      String response="{}";
      public void connect(){} public void disconnect(){} public boolean usingProxy(){return false;}
      public OutputStream getOutputStream(){return body;}
      public Map<String,List<String>> getHeaderFields(){return Map.of();}
      public InputStream getInputStream(){return new ByteArrayInputStream(response.getBytes(StandardCharsets.UTF_8));}
      public int getResponseCode() throws IOException {
        try {
          if("www.googleapis.com".equals(url.getHost())) {
            assertNull(getRequestProperty("Cookie")); assertNull(getRequestProperty("Authorization"));
            assertNull(getRequestProperty("Origin")); assertFalse(getInstanceFollowRedirects());
            assertEquals("PUT",getRequestMethod());assertEquals("video/mp4",getRequestProperty("Content-Type"));
            String range=getRequestProperty("Content-Range");
            assertEquals("bytes "+offset+"-"+(offset+body.size()-1)+"/"+file.length(),range);
            assertTrue(body.size()>0&&body.size()<=4*1024*1024);
            chunks++;destinations.add(url.toString());ranges.add(offset);
            if(expire){expire=false;return 410;}
            if(driveStatus!=0)return driveStatus;
            offset+=body.size();
            if(loseResponse){loseResponse=false;throw new IOException("Lost response from "+url);}
            return offset==file.length()?200:308;
          }
          assertEquals("/api/tablet",url.getPath());
          assertEquals("cb-kiosk=fixture-device-token",getRequestProperty("Cookie"));
          assertEquals("application/json",getRequestProperty("Content-Type"));
          assertTrue(body.size()<2048);applicationBytes+=body.size();
          JSONObject input=new JSONObject(body.toString("UTF-8"));
          assertEquals(SESSION,input.getString("id"));assertTrue(input.getBoolean("direct_upload"));
          String action=input.getString("action");JSONObject out=new JSONObject();
          if(Set.of("upload","retry-upload","restart-upload").contains(action)) {
            if(action.equals("restart-upload")){restarts++;offset=0;grantAddress=ADDRESS+"-replacement";}
            out.put("ready",false);
            if(!omitGrant)out.put("directUpload",new JSONObject().put("url",grantAddress)
                .put("bytes",grantBytes<0?file.length():grantBytes).put("mime","video/mp4"));
          } else if(action.equals("upload-status")) {
            if(offset==file.length())out.put("uploaded",true);else out.put("offset",offset);
          } else if(action.equals("finish")){finishes++;out.put("ready",confirm&&offset==file.length());}
          else fail("Unexpected action "+action);
          response=out.toString();return 200;
        } catch(JSONException malformed){throw new IOException("Malformed fixture",malformed);}
      }
    };
    Fixture() throws Exception {
      vault.put("cookies","{\"cb-kiosk\":\"fixture-device-token\"}");
      try(RandomAccessFile out=new RandomAccessFile(file,"rw")){out.setLength(5*1024*1024);}
    }
    Api api(){return new Api(vault,connections);}
    void send() throws Exception{UploadTransfer.send(file.length(),api().uploadTransport(SESSION,file),p->{});}
    public void close(){file.delete();base.getSharedPreferences(name,0).edit().clear().commit();}
  }

  @Test public void allVideoBytesGoToDriveWhileVercelReceivesOnlySmallJson() throws Exception {
    try(Fixture f=new Fixture()){
      f.send();assertEquals(2,f.chunks);assertEquals(f.file.length(),f.offset);assertEquals(1,f.finishes);
      assertTrue(f.applicationBytes<2048);assertTrue(f.file.exists());
      assertEquals(List.of(0L,4L*1024*1024),f.ranges);
      assertTrue(f.destinations.stream().allMatch(ADDRESS::equals));
      assertFalse(f.vault.object("cookies").toString().contains("upload_id"));
    }
  }

  @Test public void lostDriveResponseResumesAtConfirmedOffsetAfterTransportRecreation() throws Exception {
    try(Fixture f=new Fixture()){
      f.loseResponse=true;
      IOException failure=assertThrows(IOException.class,f::send);
      assertFalse(failure.getMessage().contains("upload_id"));assertFalse(failure.getMessage().contains("https:"));
      assertEquals(4L*1024*1024,f.offset);assertTrue(f.file.exists());
      f.send();assertEquals(2,f.chunks);assertEquals(4L*1024*1024,(long)f.ranges.get(1));
    }
  }

  @Test public void expiredDriveSessionObtainsNewDestinationWithoutVercelRelay() throws Exception {
    try(Fixture f=new Fixture()){
      f.expire=true;f.send();assertEquals(1,f.restarts);assertEquals(3,f.chunks);
      assertEquals(ADDRESS,f.destinations.get(0));
      assertEquals(ADDRESS+"-replacement",f.destinations.get(1));
    }
  }

  @Test public void missingBackendCapabilityAndMismatchedFilesNeverSendVideoBytes() throws Exception {
    try(Fixture f=new Fixture()){
      f.omitGrant=true;assertThrows(Exception.class,f::send);assertEquals(0,f.chunks);
      f.omitGrant=false;f.grantBytes=f.file.length()+1;assertThrows(Exception.class,f::send);
      assertEquals(0,f.chunks);assertTrue(f.file.exists());
    }
  }

  @Test public void unsafeDestinationsAreRejectedBeforeOpeningAConnection() throws Exception {
    try(Fixture f=new Fixture()){
      for(String address:List.of("http://www.googleapis.com/upload/drive/v3/files?upload_id=x",
          "https://attacker.invalid/upload/drive/v3/files?upload_id=x",
          "https://www.googleapis.com.attacker.invalid/upload/drive/v3/files?upload_id=x",
          "https://user@www.googleapis.com/upload/drive/v3/files?upload_id=x",
          "https://www.googleapis.com:4444/upload/drive/v3/files?upload_id=x",
          "https://www.googleapis.com/drive/v3/files?upload_id=x",
          "https://www.googleapis.com/upload/drive/v3/files?upload_id=x#fragment",
          "https://www.googleapis.com/upload/drive/v3/files")){
        f.grantAddress=address;assertThrows(Exception.class,f::send);assertEquals(0,f.chunks);
      }
    }
  }

  @Test public void driveFailureOrMissingFinalVerificationPreservesTheLocalFile() throws Exception {
    try(Fixture f=new Fixture()){
      for(int status:new int[]{307,403,429,503}){
        f.driveStatus=status;assertThrows(Exception.class,f::send);assertEquals(0,f.finishes);assertTrue(f.file.exists());
      }
      f.driveStatus=0;f.confirm=false;assertThrows(Exception.class,f::send);
      assertEquals(1,f.finishes);assertTrue(f.file.exists());
      f.confirm=true;int sent=f.chunks;f.send();assertEquals(sent,f.chunks);
    }
  }

  @Test public void liveGoogleDriveSmokeWhenExplicitlyConfigured() throws Exception {
    String port=InstrumentationRegistry.getArguments().getString("liveDirectPort");
    org.junit.Assume.assumeTrue("Opt-in disposable private Drive fixture only",port!=null);
    assertTrue(port.matches("[0-9]{4,5}"));
    try(Fixture f=new Fixture()){
      Api api=new Api(f.vault,url->(HttpURLConnection)("www.googleapis.com".equals(url.getHost())
          ?url:new URL("http://127.0.0.1:"+port+"/api/tablet")).openConnection());
      long[] percent={-1};
      UploadTransfer.send(f.file.length(),api.uploadTransport(SESSION,f.file),p->percent[0]=p);
      assertEquals(100,percent[0]);assertTrue(f.file.exists());
    }
  }
}
