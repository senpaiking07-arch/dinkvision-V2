import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { parseRecorderEvents } from "../lib/recorder-events";
import { InputError, uuid } from "../lib/validation";
const device="11111111-1111-4111-8111-111111111111",session="22222222-2222-4222-8222-222222222222";
const foreign="33333333-3333-4333-8333-333333333333",tenant="44444444-4444-4444-8444-444444444444";
const event=(sid:string|null=session)=>({event_id:crypto.randomUUID(),attempt_id:crypto.randomUUID(),session_id:sid,
  operation:"capture",stage:"reserve",result:"failed",code:"timeout",duration_ms:30000,elapsed_ms:30010,
  queue_count:3,bytes:0,retry_count:0,version_code:49,occurred_at:"2026-11-11T00:00:00.000Z"});
function fixture({enabled=true,enrolled=true,fail=false}={}) {
  const written:any[]=[];let calls=0;const module:any={exports:{}};
  runInNewContext(ts.transpileModule(readFileSync("app/api/tablet/diagnostics/route.ts","utf8"),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    exports:module.exports,process:{env:{RECORDER_DIAGNOSTICS_ENABLED:enabled?"true":"false"}},
    require(name:string) {
      if(name.endsWith("browser-tablets"))return {browserTablet:async()=>enrolled?{device:{id:device},kiosk:{tenant_id:tenant}}:null};
      if(name.endsWith("recorder-server"))return {recorderDatabase:(scope:string)=>{
        assert.equal(scope,tenant);calls++;
        return {from:(table:string)=>{
          if(table==="browser_recordings")return {select:()=>({eq:(key:string,value:string)=>{
            assert.equal(key,"device_id");assert.equal(value,device);
            return {in:async()=>({data:[{session_id:session}],error:fail?{}:null})};
          }})};
          assert.equal(table,"recorder_diagnostics");
          return {upsert:async(rows:any[],options:any)=>{
            assert.equal(options.ignoreDuplicates,true);assert.equal(options.onConflict,"tenant_id,device_id,event_id");
            written.push(...rows);return {error:fail?{}:null};
          }};
        }};
      }};
      if(name.endsWith("http"))return {
        json:(body:unknown,status=200)=>Response.json(body,{status}),
        sameOrigin:(r:Request)=>r.headers.get("origin")==="https://app.test",
        readBody:(r:Request,max:number)=>{assert.equal(max,16384);return r.json();},
      };
      if(name.endsWith("validation"))return {InputError,uuid};
      if(name.endsWith("recorder-events"))return {parseRecorderEvents};
      throw Error(name);
    },
  });
  const post=(events:unknown,origin="https://app.test",claimedDevice=device)=>module.exports.POST(new Request("https://app.test/api/tablet/diagnostics",{
    method:"POST",headers:{"Content-Type":"application/json",origin},body:JSON.stringify({device_id:claimedDevice,events})}));
  return {post,written,calls:()=>calls};
}
test("diagnostic delivery authenticates, validates and never writes another device's recording",async()=>{
  const f=fixture(),valid=event(),other=event(foreign),beforeSession=event(null);
  const response=await f.post([valid,other,beforeSession]);
  assert.equal(response.status,200);const body=await response.json();
  assert.deepEqual(body.accepted,[valid.event_id,beforeSession.event_id]);assert.deepEqual(body.rejected,[other.event_id]);
  assert.equal(f.written.length,2);assert.ok(f.written.every(row=>row.device_id===device && row.tenant_id===tenant));
  assert.equal((await f.post([{...event(),message:"email or token"}])).status,400);
  assert.equal((await f.post([event()],"https://evil.test")).status,403);
  const anonymous=fixture({enrolled:false});assert.equal((await anonymous.post([event()])).status,401);assert.equal(anonymous.calls(),0);
});
test("a buffered pre-session event cannot be attributed to a different enrollment", async () => {
  const f = fixture();
  const response = await f.post([event(null)], "https://app.test", foreign);
  assert.equal(response.status, 409);
  assert.equal(f.calls(), 0);
  assert.equal(f.written.length, 0);
});
test("disabled diagnostics and database errors do not acknowledge unsaved evidence",async()=>{
  const off=fixture({enabled:false});assert.equal((await off.post([event()])).status,503);assert.equal(off.calls(),0);
  const down=fixture({fail:true});const result=await down.post([event(null)]);
  assert.equal(result.status,503);assert.equal((await result.json()).accepted,undefined);
});

test("Admin diagnostics checks the selected tenant before reading events", async () => {
  const source = readFileSync("app/api/admin/recorder-diagnostics/route.ts", "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports: Record<string, (request: Request) => Promise<Response>> = {};
  const sample = event(null);
  let canRead = false;
  let reads = 0;
  const query = {
    eq: (column: string, value: string) => {
      assert.equal(column, "device_id");
      assert.equal(value, device);
      return query;
    },
    order: () => query,
    limit: async () => ({ data: [sample], error: null }),
  };
  runInNewContext(outputText, {
    URL,
    exports,
    process: { env: { RECORDER_DIAGNOSTICS_ENABLED: "true" } },
    require(name: string) {
      if (name === "next/headers")
        return { cookies: async () => ({ get: (key: string) => {
          assert.equal(key, "dinkvision-tenant");
          return { value: tenant };
        } }) };
      if (name.endsWith("/tenant-scope")) return { TENANT_COOKIE: "dinkvision-tenant" };
      if (name.endsWith("/auth")) return { getAccount: async () => ({ account: { role: "player" } }) };
      if (name.endsWith("/supabase-server")) return { serverSupabase: async (scope: string) => {
        assert.equal(scope, tenant);
        return {
          rpc: async (method: string) => {
            assert.equal(method, "is_admin");
            return { data: canRead, error: null };
          },
          from: () => ({ select: () => { reads++; return query; } }),
        };
      } };
      if (name.endsWith("/validation")) return { InputError, uuid };
      if (name.endsWith("/http")) return { json: (body: unknown, status = 200) => Response.json(body, { status }) };
      throw Error(name);
    },
  });
  const request = new Request("https://app.test/api/admin/recorder-diagnostics?device=" + device);
  assert.equal((await exports.GET(request)).status, 403);
  assert.equal(reads, 0);
  canRead = true;
  const response = await exports.GET(request);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).events, [sample]);
  assert.equal(reads, 1);
});
