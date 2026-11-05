package com.casabatik.recorder;
import static org.junit.Assert.*;
import org.junit.Test;
import org.json.JSONObject;

public class BrandingProgressTest {
 @Test public void slowProgressMayExceedOldDeadlineAndFortyFiveMinutes() throws Exception {
  BrandingProgress progress=new BrandingProgress(0);
  for(int frame=0;frame<10000;frame++) progress.advanced(frame*20000L,frame*1_000_000_000L);
 }
 @Test public void aStalledEncoderFailsInsteadOfResettingItsDeadline() throws Exception {
  BrandingProgress progress=new BrandingProgress(0);progress.advanced(1000,1_000_000_000L);
  progress.advanced(1000,180_000_000_000L);
  try{progress.check(181_000_000_001L);fail("Repeated timestamps are not progress");}
  catch(Exception expected){assertTrue(expected.getMessage().contains("stalled"));}
 }
 @Test public void successfullyWrittenMediaAfterSuspensionProvesRecovery() throws Exception {
  BrandingProgress progress=new BrandingProgress(0);
  progress.advancedAudio(2000,1);
  progress.advanced(1000,BrandingProgress.STALL_NANOS+1);
  progress.check(BrandingProgress.STALL_NANOS+2);
  try{progress.advanced(1000,2*BrandingProgress.STALL_NANOS+2);fail("Repeated timestamps still stall");}
  catch(Exception expected){assertTrue(expected.getMessage().contains("stalled"));}
 }
 @Test public void waitingDoesNotMutateRetryBudgetOrClaimActiveTransfer() throws Exception {
  for(String state:new String[]{"saved_locally","pending","retrying"}) {
   JSONObject item=new JSONObject().put("status",state).put("retryCount",7).put("nextRetryAt",Long.MAX_VALUE).put("localAvailable",true);
   String before=item.toString();assertTrue(Engine.waitingForWorker(item));assertEquals(before,item.toString());
   item.put("brandingState","processing");assertFalse(Engine.waitingForWorker(item));
  }
  for(String state:new String[]{"uploading","failed","uploaded","recording"})assertFalse(Engine.waitingForWorker(new JSONObject().put("status",state)));
 }
}
