import test from'node:test';import assert from'node:assert/strict';import{deviceQueueOrder,isQueuedWork,visibleDeviceQueueItem}from'../lib/device-queue-order';
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
