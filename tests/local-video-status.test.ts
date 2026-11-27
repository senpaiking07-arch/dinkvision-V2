import test from "node:test";
import assert from "node:assert/strict";
import {localProcessingLabel,reportedBrandingProgress} from "../lib/local-video-status";
test("an offline tablet cannot leave Admin claiming logo processing is still running",()=>{
  const now=Date.parse('2026-11-02T00:00:00Z');
  assert.match(localProcessingLabel({branding_state:'processing',last_seen_at:'2026-11-01T21:00:00Z',local_available:true},now),/Waiting for device/);
  assert.equal(localProcessingLabel({branding_state:'processing',branding_updated_at:'2026-11-01T23:59:55Z',local_available:true},now),'Adding logo');
  assert.match(localProcessingLabel({branding_state:'processing',branding_updated_at:'2026-11-01T21:00:00Z',upload_updated_at:'2026-11-01T23:59:55Z',local_available:true},now),/Waiting for device/,'An Admin retry timestamp is not evidence that the device is still processing');
  assert.equal(localProcessingLabel({branding_state:'processing',local_available:false},now),'File missing on device');
  assert.equal(localProcessingLabel({branding_state:'complete',local_available:false,upload_state:'uploaded'},now),'Private upload copy released');
  assert.equal(localProcessingLabel({branding_state:'complete',local_available:true},now),'');
});
test('logo percentages are measured values with an explicit unreported state',()=>{
 for(const value of [undefined,null,-1,101,NaN,'52',2.5])assert.equal(reportedBrandingProgress({branding_progress:value}),null);
 assert.equal(reportedBrandingProgress({branding_progress:0}),0);
 assert.equal(reportedBrandingProgress({branding_progress:52}),52);
 assert.equal(reportedBrandingProgress({branding_progress:100}),99);
});

test('a deliberately removed app copy is distinguished from unexplained missing footage',()=>{
 const now=Date.now();
 assert.equal(localProcessingLabel({local_available:false,upload_state:'local_only',last_error:'App copy removed by user. A separate copy was saved.'},now),'App copy removed');
 assert.equal(localProcessingLabel({local_available:false,upload_state:'failed',device_copy_saved_at:new Date(now).toISOString()},now),'App copy unavailable · export recorded');
 assert.equal(localProcessingLabel({local_available:false,upload_state:'failed'},now),'File missing on device');
});

import {recordingStageLabel} from '../lib/local-video-status';
test('stages distinguish waiting, measured processing, transfer and each failure type',()=>{
 const now=Date.now();
 assert.equal(recordingStageLabel({upload_state:'saved_locally'},now),'Waiting to add logo');
 assert.equal(recordingStageLabel({upload_state:'pending',branding_state:'complete'},now),'Waiting to upload');
 assert.equal(recordingStageLabel({upload_state:'saved_locally',branding_state:'processing',branding_progress:85,branding_updated_at:new Date(now).toISOString()},now),'Adding logo 85%');
 assert.equal(recordingStageLabel({upload_state:'uploading',branding_state:'complete',bytes:100,uploaded_bytes:25},now),'Uploading 25%');
 for (const uploaded_bytes of [null, undefined, '']) {
   assert.equal(recordingStageLabel({upload_state:'uploading', bytes:100, uploaded_bytes},now),'Uploading');
 }
 assert.equal(recordingStageLabel({upload_state:'uploading',bytes:100,uploaded_bytes:0},now),'Uploading 0%');
 assert.equal(recordingStageLabel({upload_state:'uploading',bytes:100,uploaded_bytes:100},now),'Verifying upload');
 assert.equal(recordingStageLabel({upload_state:'retrying',branding_state:'failed'},now),'Logo processing retry scheduled');
 assert.equal(recordingStageLabel({upload_state:'retrying',branding_state:'complete'},now),'Retrying automatically');
 assert.equal(recordingStageLabel({upload_state:'pending'},now,false),'Waiting to upload');
});
test('fresh waiting presence cannot resurrect stale processing progress after restart',()=>{
 const now=Date.now();
 assert.equal(recordingStageLabel({upload_state:'saved_locally',branding_state:'processing',branding_progress:85,branding_updated_at:new Date(now-120000).toISOString(),last_seen_at:new Date(now).toISOString()},now),'Waiting to add logo');
});

test('a confirmed upload retains its terminal stage after private cleanup', () => {
 assert.equal(recordingStageLabel({upload_state:'uploaded',branding_state:'complete',local_available:false},Date.now()), 'Uploaded · private upload copy released');
});
