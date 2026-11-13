import test from'node:test';import assert from'node:assert/strict';import{recordingDiagnostics}from'../lib/recording-diagnostics';
test('deleted Admin registration has a clear historical reason without inventing a USB fault',()=>{
 const d=recordingDiagnostics({status:'failed',stop_reason:null,failure_stage:'device_removed'});
 assert.equal(d.stage,'Device registration removed');assert.match(d.reason,/removed from Admin/);assert.doesNotMatch(d.reason,/USB|unplug|network/);
});
test('a reported upload/branding error is distinct from recovery guidance',()=>{
 const d=recordingDiagnostics({status:'failed',stop_reason:null,failure_stage:null,browser_recordings:{last_seen_at:null,last_error:'Saved audio ends before the video.',branding_state:'failed',local_available:true}});
 assert.equal(d.stage,'Logo processing / video validation');assert.equal(d.reason,'Saved audio ends before the video.');assert.match(d.help,/Saved videos/);
});
test('normal completion, active capture, local-only policy and unknown legacy failures are explicit',()=>{
 assert.match(recordingDiagnostics({status:'ready',stop_reason:null,failure_stage:null}).stage,/None reported/);
 assert.match(recordingDiagnostics({status:'recording',stop_reason:null,failure_stage:null}).reason,/in progress/);
 assert.match(recordingDiagnostics({status:'failed',stop_reason:'short_recording',failure_stage:'short_recording'}).stage,/No failure/);
 assert.doesNotMatch(recordingDiagnostics({status:'failed',stop_reason:'short_recording',failure_stage:'short_recording'}).help,/retry/i);
 assert.equal(recordingDiagnostics({status:'failed',stop_reason:null,failure_stage:null}).reason,'The device did not report a reason.');
 assert.equal(recordingDiagnostics({status:'ready',stop_reason:'time_limit',failure_stage:null}).reason,'Reached the maximum recording duration.');
});

test("the capture cause remains visible after an upload failure or verified delivery", () => {
 const session={
  status:"failed",stop_reason:null,failure_stage:"upload",capture_interruption_code:"camera_disconnected",
  browser_recordings:{last_seen_at:null,last_error:"Drive connection expired.",duration_ms:84_800},
 };
 const failed=recordingDiagnostics(session);
 assert.equal(failed.interruption,"Camera disconnected");
 assert.equal(failed.recoveredDuration,"1 minute 24 seconds");
 assert.equal(failed.detail,"Drive connection expired.");
 assert.equal(failed.stage,"Google Drive upload");
 const ready=recordingDiagnostics({...session,status:"ready",failure_stage:null,browser_recordings:null});
 assert.equal(ready.interruption,failed.interruption);
 assert.equal(ready.recoveredDuration,null);
});
