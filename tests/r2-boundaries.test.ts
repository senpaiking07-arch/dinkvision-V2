import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { S3Client } from "@aws-sdk/client-s3";
import { R2Store } from "../lib/r2-store";
import { R2_UPLOAD_PROTOCOL, r2PartAddress, confirmedParts } from "../lib/r2-protocol";
import { signReplay, verifyReplay } from "../lib/replay-token";
import { recordingDownloadFilename } from "../lib/recording-filename";
import { uuid } from "../lib/validation";
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
    const unsafe = new URL(await store.playback(object,true,60,'customer@example.test.mp4"\r\nInjected'));
    assert.equal(unsafe.searchParams.get("response-content-disposition"),'attachment; filename="dinkvision-replay.mp4"');
    assert.doesNotMatch(decodeURIComponent(unsafe.href),/customer|Injected/);
    await assert.rejects(()=>store.partUrl({...object,bucket:"another-tenant-bucket"},1,123),/identity mismatch/);
  } finally {client.destroy();}
});

test("guest and signed-in replay routes name downloads and keep inline playback on the existing R2 key", async () => {
  const originalKey = process.env.REPLAY_SIGNING_KEY;
  const key = Buffer.alloc(32, 8).toString("base64");
  const tenant = "00000000-0000-4000-8000-000000000001";
  const id = "abd9ac01-1404-4c9e-b6ee-28e9c17fc71a";
  const session = "a1b2c3d4-4c73-4c85-837c-8eb21eaf5ea1";
  const objectKey = `tenants/${tenant}/recordings/${session}/fc482525-4cba-4601-9300-5d7e504e2bb8.mp4`;
  const exp = Math.floor(Date.now()/1000)+60;
  const token = signReplay({v:1,tenant,file:id,exp},key);
  const file = {
    id, session_id: session, storage_provider: "r2", storage_bucket: "test-bucket", storage_key: objectKey,
    expires_at: new Date((exp + 600) * 1000).toISOString(),
    recording_sessions: { started_at: "2026-11-23T00:25:00Z", venue_time_zone: "Asia/Manila", recipient_email: "private@example.test" },
  };
  const client = new S3Client({
    region: "auto", endpoint: "https://test.r2.cloudflarestorage.com", forcePathStyle: true,
    credentials: { accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" },
  });
  const store = new R2Store(client, file.storage_bucket);
  let storageError: Error | undefined;
  const checkedStore = new R2Store({send: async () => {
    if (storageError) throw storageError;
    return { ContentLength: 1024 };
  }} as unknown as S3Client, file.storage_bucket);
  let selectedFields = "";
  const database = (scope: string) => {
    assert.equal(scope, tenant);
    return { from(table: string) {
      const filters: Record<string, unknown> = {};
      const row = () => {
        if (table === "tenants") {
          assert.equal(filters.active, true);
          return { data: { id: tenant } };
        }
        assert.equal(table, "recording_files");
        assert.equal(filters.status, "ready");
        assert.equal(filters.deleted_at, null);
        assert.ok(filters.expires_at);
        assert.ok(filters.id === id || filters.session_id === session);
        return { data: file, error: null };
      };
      const query = {
        select(fields: string) {
          if (table === "recording_files") {
            selectedFields = fields;
            assert.doesNotMatch(fields, /recipient_email|uploaded_at/);
          }
          return query;
        },
        eq(name: string, value: unknown) { filters[name] = value; return query; },
        is(name: string, value: unknown) { filters[name] = value; return query; },
        gt(name: string, value: unknown) { filters[name] = value; return query; },
        single: async () => row(),
        maybeSingle: async () => row(),
      };
      return query;
    } };
  };
  try {
    process.env.REPLAY_SIGNING_KEY = key;
    const replay = load("lib/replay-server.ts", {
      "./replay-token": { signReplay, verifyReplay },
      "./r2-server": { r2Store: () => ({head: checkedStore.head.bind(checkedStore), playback: store.playback.bind(store)}) },
      "./recorder-server": { recorderDatabase: database },
      "./recording-filename": { recordingDownloadFilename },
    });
    const dependencies = {
      "@/lib/replay-server": replay,
      "@/lib/auth": { getAccount: async () => ({ account: { tenantId: tenant } }) },
      "@/lib/supabase-server": { serverSupabase: database },
      "@/lib/validation": { uuid },
      "@/lib/http": { json: (body: unknown, status: number) => Response.json(body, { status }) },
      "next/server": { NextResponse: { redirect: (location: string, status: number) => new Response(null, { status, headers: { Location: location } }) } },
    };
    const guest = load("app/api/replay/[token]/route.ts", dependencies);
    const authorized = load("app/api/recordings/[id]/playback/route.ts", dependencies);
    for (const [route, path, params, status] of [
      [guest, "/api/replay/token", { token }, 307],
      [authorized, `/api/recordings/${session}/playback`, { id: session }, 303],
    ] as const) {
      for (const download of [false, true]) {
        const result = await route.GET(new Request(`https://test.local${path}${download ? "?download=1" : ""}`),
          { params: Promise.resolve(params) });
        assert.equal(result.status, status);
        assert.equal(result.headers.get("Cache-Control"), "private, no-store");
        assert.equal(result.headers.get("Referrer-Policy"), "no-referrer");
        if (download) assert.match(selectedFields, /recording_sessions\(started_at,venue_time_zone:configuration_snapshot->>venue_time_zone\)/);
        else assert.doesNotMatch(selectedFields, /recording_sessions/);
        const signed = new URL(result.headers.get("Location") || "");
        assert.equal(signed.pathname, `/test-bucket/${objectKey}`);
        assert.equal(signed.searchParams.get("response-content-type"), "video/mp4");
        assert.equal(signed.searchParams.get("response-content-disposition"), download
          ? `attachment; filename="2026-11-23_08-25-00_${id}.mp4"`
          : 'inline; filename="dinkvision-replay.mp4"');
        assert.doesNotMatch(decodeURIComponent(signed.href), /private@example\.test/);
      }
    }
    const expired = signReplay({v:1,tenant,file:id,exp:Math.floor(Date.now()/1000)-1},key);
    assert.equal((await guest.GET(new Request("https://test.local/api/replay/expired?download=1"),
      { params: Promise.resolve({token:expired}) })).status,404);
    await assert.rejects(() => replay.privatePlayback({ ...file, expires_at: new Date(Date.now()-1000).toISOString() }, true), /Replay expired/);
    const check = () => authorized.GET(new Request(`https://test.local/api/recordings/${session}/playback?check=1`),
      { params: Promise.resolve({id:session}) });
    const play = () => guest.GET(new Request("https://test.local/api/replay/token"),
      { params: Promise.resolve({token}) });
    assert.deepEqual(await (await check()).json(), {available:true});
    storageError = Object.assign(new Error(), {name:"NotFound", $metadata:{httpStatusCode:404}});
    for (const request of [check, play]) {
      const response = await request();
      assert.equal(response.status, 404);
      assert.equal((await response.json()).code, "recording_file_missing");
      assert.equal(response.headers.has("Location"), false);
    }
    for (const name of ["AccessDenied", "TimeoutError"]) {
      storageError = Object.assign(new Error(), {name});
      for (const request of [check, play]) {
        const response = await request();
        assert.equal(response.status, 503);
        assert.equal((await response.json()).code, undefined);
      }
    }
  } finally {
    client.destroy();
    if (originalKey === undefined) delete process.env.REPLAY_SIGNING_KEY;
    else process.env.REPLAY_SIGNING_KEY = originalKey;
  }
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
