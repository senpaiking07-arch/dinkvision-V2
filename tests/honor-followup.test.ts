import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {deviceQueueOrder,isLocalOnlyHistory} from '../lib/device-queue-order';
import {createRequire} from 'node:module';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

test('camera confirmation requires a playable current test of the exact mode',()=>{
 const source=readFileSync('android/app/src/main/assets/app.js','utf8');
 const fn=source.match(/function cameraConfirmationAllowed\([^]*?\n\}/)![0];
 const allowed=runInNewContext(`(${fn})`);
 const good={busy:false,testConfirmable:true,testReady:true,testToken:'new',selectedRecordingMode:'1080-60'};
 assert.equal(allowed(good,'1080-60','new'),true);
 for(const state of [{...good,busy:true},{...good,testConfirmable:false},{...good,testReady:false}])
   assert.equal(allowed(state,'1080-60','new'),false);
 assert.equal(allowed(good,'720-30','new'),false);
 assert.equal(allowed(good,'1080-60','old'),false);
 assert.equal(allowed(good,'1080-60',''),false);
});

test('only finished local-only history collapses; active work and problems stay visible',()=>{
 const local={session_id:'local',upload_state:'local_only'};
 assert.equal(isLocalOnlyHistory(local),true);
 assert.equal(isLocalOnlyHistory({...local,last_error:'Recording under one minute. Saved locally; no Drive upload or email.',safe_error:'Recording under one minute. Saved locally; no Drive upload or email.'}),true);
 assert.equal(isLocalOnlyHistory({...local,local_available:false}),false);
 for(const row of [{...local,branding_state:'processing'},{...local,branding_state:'failed'},
   {...local,last_error:'File missing'}, {...local,safe_error:'Validation failed'},
   ...['pending','uploading','failed','retrying','saved_locally'].map(upload_state=>({...local,upload_state}))])
   assert.equal(isLocalOnlyHistory(row),false);
});

test('Admin queue puts a branded retry before a later unbranded job, matching the worker',()=>{
 const rows=[{session_id:'later',upload_state:'pending'},
   {session_id:'branded',upload_state:'retrying',branding_state:'complete'}];
 assert.deepEqual(deviceQueueOrder(rows).map(x=>x.session_id),['branded','later']);
 assert.equal(rows[0].session_id,'later');
});

test('device card renders collapsed history with details while keeping failures outside it',()=>{
 const require=createRequire(import.meta.url), exports:{default?:()=>any}={};
 let stateIndex=0;
 const session={created_at:'2026-11-04T00:00:00Z',recipient_email:'fixture@example.invalid',status:'failed'};
 const fixture={devices:[{id:'fixture-device',name:'Fixture device',recorder_mode:'android_rtsp'}],courts:[],
   recordings:[{device_id:'fixture-device',session_id:'local-fixture',upload_state:'local_only',branding_state:'complete',
      local_available:true,bytes:1048576,recording_sessions:session,
      last_error:'Recording under one minute. Saved locally; no Drive upload or email.'},
     {device_id:'fixture-device',session_id:'failure-fixture',upload_state:'failed',branding_state:'failed',local_available:true,
      last_error:'Encoder fixture failure',recording_sessions:session},
     ...['sent','failed'].map(status=>({device_id:'fixture-device',session_id:`uploaded-${status}`,upload_state:'uploaded',
       local_available:false,recording_sessions:{...session, recording_files:[{id:`file-${status}`,status:'ready',
         storage_provider:'r2',storage_key:'fixture',email_jobs:[{status}]}]}}))],timeZone:'Asia/Manila'};
 const source=ts.transpileModule(readFileSync('components/browser-tablets-admin.tsx','utf8'),{
   compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}
 }).outputText;
 runInNewContext(source,{exports,console,require(name:string){
   if(name==='react')return{...require('react'),useEffect:()=>{},useRef:()=>({current:null}),
     useState:(initial:unknown)=>{const index=stateIndex++;return[index===0?fixture:index===1?false:initial,()=>{}];}};
   return require(name.startsWith('@/')?'../'+name.slice(2):name);
 }});
 const html=renderToStaticMarkup(exports.default!());
 const history=html.match(/<details[^>]*aria-label="Fixture device local-only history"[^>]*>[^]*?<\/details>/)![0];
 assert.ok(history);
 assert.doesNotMatch(history,/\sopen(?:=|>)/);
 assert.match(history,/Local-only videos \(1\)/);
 assert.match(history,/fixture@example.invalid/); assert.match(history,/1\.0 MB/);
 assert.match(history,/recording=local-fixture/); assert.match(history,/Local-only/);
 assert.doesNotMatch(history,/failure-fixture/);
 assert.match(html.replace(history,''),/Encoder fixture failure/);
 assert.doesNotMatch(html,/Recent uploads|uploaded-sent/);
 assert.match(html,/Replay emails needing attention \(1\)/);
 assert.match(html,/uploaded-failed/);
 assert.match(html,/Retry replay email/);
});
