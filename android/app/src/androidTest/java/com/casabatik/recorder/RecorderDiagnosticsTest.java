package com.casabatik.recorder;

import static org.junit.Assert.*;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.json.*;
import org.junit.Test;

public class RecorderDiagnosticsTest {
  @Test public void journalSurvivesRestartAndAcknowledgesOnlyItsOwnEventIds() throws Exception {
    File directory=new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(),"diagnostics-"+UUID.randomUUID());
    assertTrue(directory.mkdirs());
    String device=UUID.randomUUID().toString(),session=UUID.randomUUID().toString();
    RecorderDiagnostics diagnostics=new RecorderDiagnostics(directory);
    try {
      RecorderDiagnostics.Trace trace=diagnostics.begin(device,"capture","",5,0,0);
      trace.stage("reserve");trace.session(session);
      trace.stage("camera_prepare");trace.finish(new java.net.SocketTimeoutException("secret URL and email must never be logged"));
      diagnostics.awaitWrites();
      RecorderDiagnostics restored=new RecorderDiagnostics(directory);
      JSONArray batch=restored.batch(device);
      assertEquals(3,batch.length());
      assertEquals("timeout",batch.getJSONObject(2).getString("code"));
      assertEquals(session,batch.getJSONObject(2).getString("session_id"));
      assertFalse(batch.toString().contains("secret"));
      assertTrue(batch.getJSONObject(0).getString("occurred_at").matches(".*\\.\\d{3}Z"));
      assertEquals(0,restored.batch(UUID.randomUUID().toString()).length());
      restored.acknowledge(UUID.randomUUID().toString(),new JSONArray().put(batch.getJSONObject(0).getString("event_id")));
      assertEquals(3,restored.batch(device).length());
      restored.acknowledge(device,new JSONArray().put(batch.getJSONObject(0).getString("event_id")));
      assertEquals(2,new RecorderDiagnostics(directory).batch(device).length());
    }finally{
      new File(directory,"recorder-diagnostics.json").delete();
      new File(directory,"recorder-diagnostics.json.bak").delete();directory.delete();
    }
  }
  @Test public void capturesStartAndStopSourcesAndBatchesDuplicatePresses() throws Exception {
    File directory = new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(),
        "recorder-actions-" + UUID.randomUUID());
    assertTrue(directory.mkdirs());
    String device = UUID.randomUUID().toString(), session = UUID.randomUUID().toString();
    RecorderDiagnostics diagnostics = new RecorderDiagnostics(directory);
    try {
      var trace = diagnostics.beginCapture(device, 3, System.nanoTime(), 21);
      trace.accepted();
      trace.repeatedStart();
      trace.repeatedStart();
      trace.session(session);
      trace.stopRequested(RecorderDiagnostics.ActionSource.NOTIFICATION);
      trace.stopRequested(RecorderDiagnostics.ActionSource.ADMIN);
      trace.repeatedStop(RecorderDiagnostics.ActionSource.PLAYER);
      trace.finish(null);
      diagnostics.awaitWrites();
      JSONArray batch = diagnostics.batch(device);
      assertEquals(7, batch.length());
      assertEquals("start_tap", batch.getJSONObject(0).getString("stage"));
      assertEquals(0, batch.getJSONObject(0).getLong("elapsed_ms"));
      assertEquals("start_accepted", batch.getJSONObject(1).getString("stage"));
      assertTrue(batch.getJSONObject(1).getLong("elapsed_ms") >= 21);
      assertEquals("notification", batch.getJSONObject(2).getString("action_source"));
      assertEquals(2, batch.getJSONObject(3).getInt("repeated_actions"));
      assertEquals("start_repeated", batch.getJSONObject(3).getString("stage"));
      assertEquals("stop_repeated", batch.getJSONObject(4).getString("stage"));
      assertEquals(1, batch.getJSONObject(4).getInt("repeated_actions"));
      for (int index = 0; index < batch.length(); index++)
        assertEquals(batch.getJSONObject(0).getString("attempt_id"), batch.getJSONObject(index).getString("attempt_id"));
      assertEquals(session, batch.getJSONObject(4).getString("session_id"));
    } finally {
      new File(directory, "recorder-diagnostics.json").delete();
      directory.delete();
    }
  }
}
