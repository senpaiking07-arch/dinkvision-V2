import test from'node:test';import assert from'node:assert/strict';import{deviceQueueOrder,isQueuedWork,visibleDeviceQueueItem}from'../lib/device-queue-order';
import { recordingStageLabel } from "../lib/local-video-status";
test("Drive-acknowledged bytes distinguish transfer from verification and completion", () => {
  const row = { upload_state: "uploading", bytes: 10_000, uploaded_bytes: 9999 };
  assert.equal(recordingStageLabel(row, 0), "Uploading 99%");
  assert.equal(recordingStageLabel({ ...row, uploaded_bytes: row.bytes }, 0), "Verifying upload");
  assert.equal(recordingStageLabel({ ...row, upload_state: "uploaded" }, 0), "Uploaded");
  assert.equal(recordingStageLabel({ upload_state: "failed",
    recording_sessions: { capture_inspection_required: true } }, 0), "Interrupted video · inspection required");
});
test("deferred work appears after eligible FIFO work and changes label when its delay elapses", () => {
  const now = Date.parse("2026-11-12T02:00:00Z");
  const retry = { session_id: "retry", upload_state: "retrying", branding_state: "complete",
    upload_queued_at: "2026-11-12T01:00:00Z", upload_retry_at: "2026-11-12T02:05:00Z" };
  const waiting = { session_id: "wait", upload_state: "pending", branding_state: "complete",
    upload_queued_at: "2026-11-12T01:55:00Z", upload_retry_at: null };
  assert.deepEqual(deviceQueueOrder([retry, waiting], now).map(row => row.session_id), ["wait", "retry"]);
  assert.equal(recordingStageLabel(retry, now), "Upload retry scheduled");
  assert.equal(recordingStageLabel(waiting, now), "Waiting to upload");
  assert.deepEqual(deviceQueueOrder([retry, waiting], now + 300_001).map(row => row.session_id), ["retry", "wait"]);
  assert.equal(recordingStageLabel(retry, now + 300_001), "Waiting to upload");
});
test('Admin shows current processing first, FIFO waiting work next, then retry and history',()=>{
 const rows=[{session_id:'new',upload_state:'saved_locally',client_created_at:'2026-11-02T02:00:00Z'},
 {session_id:'old',upload_state:'pending',client_created_at:'2026-11-02T01:00:00Z'},
 {session_id:'retry',upload_state:'retrying',client_created_at:'2026-11-02T00:00:00Z'},
 {session_id:'active',upload_state:'uploading',client_created_at:'2026-11-02T03:00:00Z'},
 {session_id:'local',upload_state:'local_only'}, {session_id:'failed',upload_state:'failed'}];
 const sorted=deviceQueueOrder(rows);assert.deepEqual(sorted.map(x=>x.session_id),['active','old','new','retry','failed','local']);
 assert.deepEqual(sorted.filter(isQueuedWork).map((x,i)=>[i+1,x.session_id]),[[1,'active'],[2,'old'],[3,'new'],[4,'retry']]);
 assert.equal(rows[0].session_id,'new','Sorting must not mutate API state');
});
test('uploaded and explicitly removed app copies leave the device queue after ten seconds without hiding unsent work',()=>{
 const now=Date.parse('2026-11-02T08:00:00Z');
 for(const row of [{upload_state:'uploaded',local_available:false},{upload_state:'local_only',local_available:false,last_error:'App copy removed by user. Export retained.'}]){
   assert.equal(visibleDeviceQueueItem({...row,upload_updated_at:new Date(now-9999).toISOString()},now),true);
   assert.equal(visibleDeviceQueueItem({...row,upload_updated_at:new Date(now-10000).toISOString()},now),false);
   assert.equal(visibleDeviceQueueItem(row,now),false,'Legacy completed history should not fill the live queue');
 }
 for(const upload_state of ['pending','retrying','failed','local_only','saved_locally'])
   assert.equal(visibleDeviceQueueItem({upload_state,local_available:true,upload_updated_at:new Date(now-600000).toISOString()},now),true);
 assert.equal(visibleDeviceQueueItem({upload_state:'uploaded',local_available:true},now),true,'A backup not yet released still needs attention');
 assert.equal(visibleDeviceQueueItem({upload_state:'failed',local_available:false},now),true,'An unexplained missing file must remain visible');
});
