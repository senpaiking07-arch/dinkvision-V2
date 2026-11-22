import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { S3Client } from "@aws-sdk/client-s3";
import { R2Store } from "../lib/r2-store";
import { R2_UPLOAD_PROTOCOL, r2PartAddress, confirmedParts } from "../lib/r2-protocol";
import { signReplay, verifyReplay } from "../lib/replay-token";
import * as optionalSchema from "../lib/optional-schema";

function load(path:string, dependencies:Record<string,unknown>) {
  const exports:any={};
  const source=ts.transpileModule(readFileSync(path,"utf8"),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  runInNewContext(source,{exports,URL,Date,Error,process,require:(name:string)=>dependencies[name] || {}});
  return exports;
}

test("R2 routes deny unenrolled, foreign, cross-origin and obsolete clients before issuing grants",async()=>{
  for(const scenario of [
    {status:200}, {status:401,unenrolled:true}, {status:403,foreign:true},
    {status:403,wrongOrigin:true}, {status:426,obsolete:true}, {status:409,inspection:true},
  ]) {
    let calls=0;
    const route=load("app/api/tablet/route.ts",{
      "@/lib/r2-server":{usesR2:()=>true},
      "@/lib/r2-protocol":{R2_UPLOAD_PROTOCOL},
      "@/lib/optional-schema":optionalSchema,
      "@/lib/browser-tablets":{browserTablet:async()=>scenario.unenrolled?null:{device:{id:"device"},kiosk:{id:"kiosk",tenant_id:"tenant"}}},
      "@/lib/recorder-server":{recorderDatabase:(tenant:string)=>{
        assert.equal(tenant,"tenant");return {from:()=>{
          const q:any={select:()=>q,eq:()=>q,update:()=>q,then:(yes:any)=>Promise.resolve({error:null}).then(yes),maybeSingle:async()=>({error:null,data:scenario.foreign?null:
            {session_id:"session",recording_sessions:{capture_inspection_required:!!scenario.inspection}}})};return q;
        }};
      }},
      "@/lib/http":{sameOrigin:()=>!scenario.wrongOrigin,
        readBody:async()=>({action:"upload",id:"session",upload_protocol:scenario.obsolete?undefined:R2_UPLOAD_PROTOCOL}),
        json:(body:any,status=200)=>Response.json(body,{status})},
      "@/lib/validation":{uuid:(id:string)=>id,InputError:class extends Error{}},
      "@/lib/r2-upload":{r2Upload:async(session:string,device:string,tenant:string)=>{
        assert.deepEqual([session,device,tenant],["session","device","tenant"]);calls++;return {ready:false};
      }},
    });
    const response=await route.POST(new Request("http://127.0.0.1:3000/api/tablet",{method:"POST"}));
    assert.equal(response.status,scenario.status,await response.text());
    assert.equal(calls,scenario.status===200?1:0);
  }
});

test("R2 SDK signing binds length, object and expiry without calling the network",async()=>{
  const client=new S3Client({region:"auto",endpoint:"https://42c7c9ce788292c080caf0ad3e8daded.r2.cloudflarestorage.com",
    forcePathStyle:true,credentials:{accessKeyId:"fixture-access",secretAccessKey:"fixture-secret"},
    requestChecksumCalculation:"WHEN_REQUIRED",responseChecksumValidation:"WHEN_REQUIRED"});
  try {
    const store=new R2Store(client,"test-bucket");
    const object={bucket:"test-bucket",object_key:"tenants/tenant/recordings/file.mp4",upload_id:"upload-id"};
    const part=new URL(r2PartAddress(await store.partUrl(object,2,123)));
    assert.equal(part.pathname,"/test-bucket/tenants/tenant/recordings/file.mp4");
    assert.equal(part.searchParams.get("partNumber"),"2");
    assert.equal(part.searchParams.get("X-Amz-Expires"),"300");
    assert.match(part.searchParams.get("X-Amz-SignedHeaders") || "",/content-length/);
    assert.equal(part.searchParams.has("x-amz-checksum-crc32"),false);
    const playback=new URL(await store.playback(object,true,60));
    assert.equal(playback.searchParams.get("X-Amz-Expires"),"60");
    assert.match(playback.searchParams.get("response-content-disposition") || "",/^attachment/);
    await assert.rejects(()=>store.partUrl({...object,bucket:"another-tenant-bucket"},1,123),/identity mismatch/);
  } finally {client.destroy();}
});

test("R2 part listing follows pagination and bounds malformed responses",async()=>{
  const markers:any[]=[];
  const client={send:async(command:any)=>{
    markers.push(command.input.PartNumberMarker);
    return markers.length===1?{Parts:[{PartNumber:1}],IsTruncated:true,NextPartNumberMarker:"1000"}:{Parts:[{PartNumber:1001}]};
  }} as unknown as S3Client;
  const object={bucket:"test",object_key:"tenants/test/video",upload_id:"id"};
  assert.equal((await new R2Store(client,"test").parts(object)).length,2);
  assert.deepEqual(markers,[undefined,"1000"]);
  const invalid={send:async()=>({IsTruncated:true})} as unknown as S3Client;
  await assert.rejects(()=>new R2Store(invalid,"test").parts(object),/pagination/);
});

test("guest replay requires an active tenant and a ready, unexpired file",async()=>{
  const old=process.env.REPLAY_SIGNING_KEY;
  const key=Buffer.alloc(32,9).toString("base64");process.env.REPLAY_SIGNING_KEY=key;
  const tenant="00000000-0000-4000-8000-000000000001",file="00000000-0000-4000-8000-000000000002";
  const exp=Math.floor(Date.now()/1000)+60;
  const token=signReplay({v:1,tenant,file,exp},key);
  let active=true,exists=true,fileQueries=0;
  try {
    const api=load("lib/replay-server.ts",{
      "./replay-token":{signReplay,verifyReplay},
      "./recorder-server":{recorderDatabase:(scope:string)=>{
        assert.equal(scope,tenant);return {from:(table:string)=>{
          const filters:Record<string,unknown>={};
          const q:any={select:()=>q,eq:(k:string,v:unknown)=>{filters[k]=v;return q;},
            is:(k:string,v:unknown)=>{filters[k]=v;return q;},gt:(k:string,v:unknown)=>{filters[k]=v;return q;},
            maybeSingle:async()=>{
              if(table==="tenants")return {data:active?{id:tenant}:null};
              fileQueries++;assert.equal(filters.id,file);assert.equal(filters.status,"ready");
              assert.equal(filters.storage_provider,"r2");assert.equal(filters.deleted_at,null);assert.ok(filters.expires_at);
              return {data:exists?{id:file,expires_at:new Date(Date.now()+3600000).toISOString()}:null};
            }};return q;
        }};
      }},
    });
    assert.equal(Date.parse((await api.guestReplay(token)).expires_at),exp*1000);
    active=false;assert.equal(await api.guestReplay(token),null);assert.equal(fileQueries,1);
    active=true;exists=false;assert.equal(await api.guestReplay(token),null);
    assert.equal(await api.guestReplay("forged"),null);
  } finally {if(old===undefined)delete process.env.REPLAY_SIGNING_KEY;else process.env.REPLAY_SIGNING_KEY=old;}
});

test("background probes do not keep abandoned partial uploads alive",async()=>{
  let complete=false,finishes=0;
  const api=load("lib/r2-jobs.ts",{
    "./r2-protocol":{confirmedParts},
    "./r2-server":{r2Store:()=>({head:async()=>null,parts:async()=>complete?[{PartNumber:1,Size:10,ETag:'"ok"'}]:[]})},
    "./r2-upload":{r2Upload:async()=>{finishes++;}},
    "./email-server":{deliverNextEmail:async()=>{}},
    "./recorder-server":{recorderDatabase:()=>({from:(table:string)=>{
      let uploading=false;
      const q:any={select:()=>q,eq:(key:string)=>{if(key==="state")uploading=true;return q;},
        in:()=>q,is:()=>q,lte:()=>q,order:()=>q,limit:()=>q,or:()=>q,
        update:()=>{assert.equal(table,"venue_settings","a passive probe cannot refresh upload timestamps");return q;},
        then:(yes:any)=>Promise.resolve({error:null,data:table==="r2_upload_attempts"&&uploading?
          [{id:"attempt",device_id:"device",session_id:"session",bytes:10}]:[]}).then(yes)};
      return q;
    }})},
  });
  await api.runR2Jobs("tenant");assert.equal(finishes,0);
  complete=true;await api.runR2Jobs("tenant");assert.equal(finishes,1);
});
