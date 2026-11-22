import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { uuid } from "../lib/validation";
import { sessionCaptureReport } from "../lib/recording-status";
import * as optionalSchema from "../lib/optional-schema";

const id = "0c99e1e5-0000-4000-8000-000000000001";
const other = "332b40d0-0000-4000-8000-000000000002";
const compiled = ts.transpileModule(readFileSync(new URL("../app/admin/page.tsx", import.meta.url), "utf8"), {
  compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
}).outputText;

async function openLog(recording: string, role = "admin", exists = true) {
  let lookups = 0;
  const reportReads: string[][] = [];
  const Dashboard = () => null;
  const exports: {default?: (props: unknown) => Promise<unknown>} = {};
  runInNewContext(compiled, {
    exports,
    require(name: string) {
      if (name === "@/lib/r2-server") return {usesR2: () => false};
      if(name === "react/jsx-runtime") return jsx;
      if(name === "next/navigation") return {redirect: () => {throw Error("redirected");}};
      if(name === "@/lib/validation") return {uuid};
      if(name === "@/lib/recording-status") return {sessionCaptureReport};
      if(name === "@/lib/optional-schema") return optionalSchema;
      if(name === "@/lib/auth") return {getAccount:async()=>({account:{role}})};
      if(name === "@/components/admin-dashboard") return {default:Dashboard};
      if(name === "@/lib/recorder-server") return {recorderDatabase:()=>({from:(table:string)=>({select:()=>({in:(_key:string,ids:string[])=>{
        assert.equal(table,"browser_recordings");reportReads.push(ids);
        return Promise.resolve({data:ids.map(session_id=>({session_id,last_seen_at:"2026-11-02T07:27:18Z"})),error:null});
      }})})})};
      if(name === "@/lib/supabase-server") return {serverSupabase:async()=>({from:(table:string)=>{
        const data = table === "recording_sessions" ? [{id:other,created_at:"2026-11-01T00:00:00Z",configuration_snapshot:{capture_mode:"browser"},browser_recordings:[]}]
          : table === "venue_settings" ? {venue_time_zone:"Asia/Manila"} : [];
        const query = {
          select:()=>query,eq:()=>query,order:()=>query,
          limit:async()=>({data,error:null}),single:async()=>({data,error:null}),
          maybeSingle:async()=>{lookups++;return {data:exists?{id,created_at:"2026-10-30T00:00:00Z",configuration_snapshot:{capture_mode:"browser"},browser_recordings:[]}:null,error:null};},
          then:(resolve:(value:unknown)=>void)=>resolve({data,error:null}),
        };
        return query;
      }})};
      return {default:()=>null};
    },
  });
  const page = await exports.default!({searchParams:Promise.resolve({recording})});
  function find(node:any):any {
    if(!node || typeof node!=='object')return null;
    if(node.type===Dashboard)return node.props;
    for(const child of Array.isArray(node.props?.children)?node.props.children:[node.props?.children]) {
      const found=find(child);if(found)return found;
    }
    return null;
  }
  return {dashboard:find(page),lookups,reportReads};
}

test("a queue link opens an older recording outside the latest 100 in logs", async()=>{
  const result=await openLog(id);
  assert.equal(result.dashboard.initialRecordingId,id);
  assert.equal(result.lookups,1);
  assert.ok(result.dashboard.data.sessions.some((row:any)=>row.id===id));
});

test("log links use existing administrator access and do not fabricate inaccessible sessions", async()=>{
  assert.equal((await openLog(id,"player")).dashboard,null);
  const missing=await openLog(id,"admin",false);
  assert.equal(missing.dashboard.initialRecordingId,id);
  assert.equal(missing.dashboard.data.sessions.some((row:any)=>row.id===id),false);
  const invalid=await openLog("not-a-session");
  assert.equal(invalid.dashboard.initialRecordingId,"");
  assert.equal(invalid.lookups,0);
});

test("Admin uses current private capture reports even when the authenticated relation is RLS-hidden",async()=>{
  const result=await openLog(id);
  assert.equal(result.dashboard.data.captureReports.find((r:any)=>r.session_id===other)?.last_seen_at,"2026-11-02T07:27:18Z");
  assert.equal(result.dashboard.data.captureReports.find((r:any)=>r.session_id===id)?.last_seen_at,"2026-11-02T07:27:18Z");
  assert.deepEqual(result.reportReads.flat().sort(),[other,id].sort());
  const forbidden=await openLog(id,"player");
  assert.equal(forbidden.reportReads.length,0);
  const missing=await openLog(id,"admin",false);
  assert.deepEqual(missing.reportReads.flat(),[other]);
});
