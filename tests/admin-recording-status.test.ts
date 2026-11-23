import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

const requireLocal = createRequire(import.meta.url);
const now = Date.parse("2026-11-01T19:10:00Z");
const source = ts.transpileModule(readFileSync(new URL("../components/admin-dashboard.tsx", import.meta.url), "utf8"), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
}).outputText;

function dashboard(lastSeen: string | null, started = "2026-11-01T14:03:39Z", status = "recording", retentionSeconds?: number) {
  const session = {id:"capture",court_id:"court",status,created_at:started,started_at:started,stopped_at:null,
    duration_seconds:900,recipient_email:"player@gmail.com",configuration_snapshot:{capture_mode:"browser",device_id:"tablet"}};
  const data = {courts:[{id:"court",name:"REN",active:true}],sessions:[session],settings:{venue_time_zone:"Asia/Manila",max_duration_seconds:900,retention_seconds:retentionSeconds ?? 86400},recorders:[],cameras:[],events:[],devices:[],commands:[],
    captureReports:[{session_id:"capture",last_seen_at:lastSeen,device_id:"tablet"}]};
  const exports:any = {};
  let stateIndex = 0;
  runInNewContext(source, {exports,Date:class extends Date { static now(){return now;} },
    require(name:string){
      if(name === "react/jsx-runtime")return jsx;
      if(name === "react")return {useState:(initial:any)=>{
        const index = stateIndex++;
        return [index === 0 && retentionSeconds !== undefined ? "settings" : index === 3 ? [] : initial, ()=>{}];
      },useCallback:(fn:unknown)=>fn,useRef:()=>({current:null}),useEffect:()=>{}};
      if(name === "./use-admin-realtime")return {useAdminRealtime:(initial:unknown)=>({data:initial, stale:false})};
      if(name === "next/navigation")return {useRouter:()=>({refresh(){}})};
      if(name === "@/lib/recording-status")return requireLocal("../lib/recording-status.ts");
      if(name === "@/lib/camera-health")return requireLocal("../lib/camera-health.ts");
      if(name === "@/lib/device-presence")return requireLocal("../lib/device-presence.ts");
      if(name === "@/lib/validation")return requireLocal("../lib/validation.ts");
      if(name === "@/lib/recorder-status")return {cameraOnline:()=>false};
      return new Proxy({default:()=>null},{get:(target:any,key)=>target[key]||(()=>null)});
    },
  });
  return renderToStaticMarkup(exports.default({data}));
}

test("offline capture from hours ago is unconfirmed rather than Recording now or idle",()=>{
  const html = dashboard("2026-11-01T14:05:37Z");
  assert.match(html,/Recording unconfirmed/);
  assert.doesNotMatch(html,/>Recording now<|All courts are currently idle/);
});

test("a recent capture report within its configured duration remains live",()=>{
  const html = dashboard("2026-11-01T19:09:58Z","2026-11-01T19:05:00Z");
  assert.match(html,/>Recording now</);
});

test("an overdue capture is unconfirmed even if another heartbeat is recent",()=>{
  assert.match(dashboard("2026-11-01T19:09:58Z"),/Recording unconfirmed/);
});

test("ended captures with an uploading queue are not called live recordings",()=>{
  assert.match(dashboard("2026-11-01T19:09:58Z","2026-11-01T19:05:00Z","uploading"),/No live recordings/);
});

test("Admin settings load saved retention in days without truncating legacy values", () => {
  for (const [seconds, days] of [[604800, 7], [108000, 1.25], [3600, 1 / 24], [3601, 3601 / 86400]]) {
    const html = dashboard(null, undefined, "ready", seconds);
    assert.match(html, /Video retention after upload \(days\)/);
    const field = html.match(/<input[^>]+name="retention_days"[^>]*>/)?.[0];
    assert.ok(field);
    assert.ok(field.includes(`value="${days}"`));
    assert.match(field, /step="any"/);
  }
});
