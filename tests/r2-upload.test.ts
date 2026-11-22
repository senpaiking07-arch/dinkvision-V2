import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as protocol from "../lib/r2-protocol";

const source=ts.transpileModule(readFileSync("lib/r2-upload.ts","utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(bytes = protocol.R2_PART_SIZE + 5) {
 const b:any={session_id:"session",device_id:"device",file_id:"file",bytes,mime_type:"video/mp4",upload_state:"uploading",lease_until:null};
 let counter=0;
 const state={attempt:null as any,parts:[] as any[],head:null as any,creates:0,signatures:0,completions:0,finishes:0,allowed:true,lostCompletion:false,storageError:false};
 const db={
  rpc:async(name:string,input:any)=>{
   if(name==="report_browser_upload") return {data:true,error:null};
   assert.equal(name,"finish_r2_upload");assert.equal(input.p_bytes,b.bytes);assert.equal(input.p_etag,state.head.ETag);
   state.finishes++;b.upload_state="uploaded";state.attempt.state="completed";return {data:true,error:null};
  },
  from:(table:string)=>{
   const filters:any={};let patch:any,insert:any;
   const result=()=>{
    let row=table==="browser_recordings"?b:state.attempt;
    if(insert) {state.attempt={...insert};row=state.attempt;}
    if(row && Object.entries(filters).some(([k,v])=>row[k]!==v)) return {data:null,error:null};
    if(patch && row) Object.assign(row,patch);
    return {data:row?{...row}:null,error:null};
   };
   const q:any={select:()=>q,eq:(k:string,v:any)=>{filters[k]=v;return q;},in:()=>q,or:()=>q,gt:()=>q,order:()=>q,limit:()=>q,
    update:(value:any)=>{patch=value;return q;},insert:(value:any)=>{insert=value;return q;},maybeSingle:async()=>result(),
    then:(resolve:any,reject:any)=>Promise.resolve(result()).then(resolve,reject)};
   return q;
  },
 };
 const store={bucket:"bucket",head:async()=>state.head,
  create:async()=>{state.creates++;return "remote-upload";},abort:async()=>{},
  parts:async()=>{if(state.storageError)throw Error("https://secret-url.invalid/?token=secret");return state.parts;},
  partUrl:async()=>{state.signatures++;return "private-part-url";},
  partUrls:async(_obj:any,entries:any[])=>{state.signatures+=entries.length;return entries.map((e:any)=>({partNumber:e.number,length:e.length,url:`private-part-url-${e.number}`}));},
  complete:async()=>{
   state.completions++;
   state.head={ContentLength:b.bytes,ContentType:"video/mp4",ETag:'"complete"',Metadata:{attempt:state.attempt.id,session:"session",tenant:"tenant"}};
   if(state.lostCompletion) throw Error("Response lost");
  },
 };
 const exports:any={};
 runInNewContext(source,{exports,Date,Number,Set,Error,require(name:string){
  if(name==="server-only")return{};
  if(name==="node:crypto")return{randomUUID:()=>`id-${++counter}`};
  if(name==="./recorder-server")return{recorderDatabase:(tenant:string)=>{assert.equal(tenant,"tenant");return db;}};
  if(name==="./r2-server")return{r2Store:()=>store};
  if(name==="./r2-store")return{missingUpload:(error:any)=>error.name==="NoSuchUpload"};
  if(name==="./r2-protocol")return protocol;
  if(name==="./browser-upload")return{browserUploadQueue:async()=>({allowed:state.allowed,state:b.upload_state})};
  throw Error(name);
 }});
 return {state,b,call:(action:string,body:any={})=>exports.r2Upload("session","device","tenant",action,body)};
}

test("prepare is idempotent and grants sequential/batched part URLs while preserving attempt identity",async()=>{
 const f=fixture();const prepared=await f.call("upload");
 assert.equal(prepared.upload.protocol,protocol.R2_UPLOAD_PROTOCOL);assert.equal(prepared.upload.url,undefined);
 assert.equal(prepared.upload.partSize,protocol.R2_DEFAULT_PART_SIZE);
 assert.equal((await f.call("upload")).upload.attemptId,prepared.upload.attemptId);assert.equal(f.state.creates,1);
 await assert.rejects(()=>f.call("upload-part",{attempt_id:"old",part_number:1}),/attempt changed/);
 await assert.rejects(()=>f.call("upload-part",{attempt_id:prepared.upload.attemptId,part_number:2,reconcile:true}),/Invalid upload part|progress changed/);
 const part=await f.call("upload-part",{attempt_id:prepared.upload.attemptId,part_number:1,reconcile:true});
 assert.equal(part.length,f.b.bytes);assert.equal(f.state.signatures,1);
 f.state.allowed=false;assert.equal((await f.call("upload-part",{attempt_id:prepared.upload.attemptId,part_number:1,reconcile:true})).queued,true);
 assert.equal(f.state.signatures,1);
});

test("530 MiB recording receives APK-compatible batch grants and a short final part",async()=>{
 const f=fixture(556434927);
 const {upload}=await f.call("upload");
 const partSize=upload.partSize;
 const lastPart=Math.ceil(f.b.bytes/partSize);
 for(const reconcile of [false,true]){
   const reply=await f.call("upload-parts",{attempt_id:upload.attemptId,part_numbers:[1,2,3,4],reconcile});
   assert.equal(reply.offset,0);
   for(const [index,part] of reply.parts.entries()){
     assert.equal(part.partNumber,index+1);
     assert.equal(part.offset,index*partSize);
     assert.equal(part.length,partSize);
     assert.equal(part.attemptId,upload.attemptId);
   }
 }
 f.state.parts=Array.from({length:lastPart-1},(_,index)=>({PartNumber:index+1,Size:partSize,ETag:`"part-${index+1}"`}));
 const tail=await f.call("upload-part",{attempt_id:upload.attemptId,part_number:lastPart,reconcile:true});
 assert.equal(tail.partNumber,lastPart);
 assert.equal(tail.offset,(lastPart-1)*partSize);
 assert.equal(tail.length,f.b.bytes-tail.offset);
 assert.equal(tail.parts[0].offset,tail.offset);
 assert.equal(tail.parts[0].attemptId,upload.attemptId);
});

test("negotiates larger parts only when needed and respects the R2 object ceiling", async () => {
 const f = fixture(protocol.R2_MAX_BYTES);
 await assert.rejects(() => f.call("upload"), /Update the recorder/);
 assert.equal(f.state.creates, 0);
 const { upload } = await f.call("upload", { large_parts: true });
 assert.ok(upload.partSize > 32 * 1024 * 1024);
 assert.ok(Math.ceil(f.b.bytes / upload.partSize) <= protocol.R2_MAX_PARTS);
 assert.equal(upload.parallelism, 1);
 const part = await f.call("upload-part", { attempt_id: upload.attemptId, part_number: 1 });
 assert.equal(part.length, upload.partSize);
 assert.equal((await f.call("upload", { large_parts: true })).upload.partSize, upload.partSize);
 const tooLarge = fixture(protocol.R2_MAX_BYTES + 1);
 await assert.rejects(() => tooLarge.call("upload", { large_parts: true }), /exceeds the Cloudflare R2 object limit/);
 assert.equal(tooLarge.state.creates, 0);
 const standard = fixture(200 * 1024 ** 3);
 assert.equal((await standard.call("upload")).upload.partSize, 32 * 1024 * 1024);
});

test("finish verifies R2 metadata, recovers a lost completion response and commits only once",async()=>{
 const f=fixture();const prepared=await f.call("upload");const body={attempt_id:prepared.upload.attemptId};
 await assert.rejects(()=>f.call("finish",body),/not complete/);
 f.state.parts=[{PartNumber:1,Size:f.b.bytes,ETag:'"1"'}];
 f.state.lostCompletion=true;
 assert.equal((await f.call("finish",body)).ready,true);
 assert.equal((await f.call("finish",body)).ready,true);
 assert.equal(f.state.completions,1);assert.equal(f.state.finishes,1);
 const bad=fixture();const grant=await bad.call("upload");
 bad.state.head={ContentLength:bad.b.bytes,ContentType:"video/mp4",ETag:'"bad"',Metadata:{attempt:grant.upload.attemptId,session:"other",tenant:"tenant"}};
 await assert.rejects(()=>bad.call("finish",{attempt_id:grant.upload.attemptId}),/does not match/);
 assert.equal(bad.state.finishes,0);
});

test("storage errors cannot expose signed URLs and always release the upload lease",async()=>{
 const f=fixture();const grant=await f.call("upload");f.state.storageError=true;
 await assert.rejects(()=>f.call("upload-status",{attempt_id:grant.upload.attemptId}),error=>{
  assert.doesNotMatch(String(error),/secret-url|token=/);return true;
 });
 assert.equal(f.b.lease_until,null);assert.equal(f.state.finishes,0);
});

test("background reconciliation cannot upload footage awaiting inspection",async()=>{
 const f=fixture();f.b.recording_sessions={capture_inspection_required:true};
 await assert.rejects(()=>f.call("upload"),/Inspect the interrupted recording/);
 assert.equal(f.state.creates,0);assert.equal(f.b.lease_until,null);
});
