import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import ts from "typescript";
import * as optionalSchema from "../lib/optional-schema";
import { uuid } from "../lib/validation";

const source = ts.transpileModule(readFileSync(new URL("../app/admin/page.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const recording = "abcd1234-1234-4123-9123-123456789abc";

async function dashboard(error: {code: string; message: string}) {
  const selections: string[] = [];
  const exports: { default?: (props: unknown) => Promise<ReactNode> } = {};
  const db = { from(table: string) {
    let fields = "";
    const result = (single = false) => {
      if (table === "recording_sessions") {
        selections.push(fields);
        if (fields.includes("capture_interruption_code")) return {data:null, error};
        if (single) return {data:{id:recording,configuration_snapshot:{}},error:null};
      }
      return {data:single ? {} : [],error:null};
    };
    const query = {
      select: (value: string) => { fields = value; return query; },
      order: () => query, limit: () => query, eq: () => query,
      single: async () => result(true), maybeSingle: async () => result(true),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return query;
  } };
  runInNewContext(source, { exports, require(name: string) {
      if (name === "@/lib/r2-server") return {usesR2: () => false};
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name === "@/lib/auth") return { getAccount: async () => ({account:{role: 'admin', tenantId: '00000000-0000-4000-8000-000000000001'}}) };
    if (name === "@/lib/supabase-server") return { serverSupabase: async () => db };
    if (name === "@/lib/recorder-server") return { recorderDatabase: () => db };
    if (name === "@/lib/validation") return { uuid };
    if (name === "@/lib/optional-schema") return optionalSchema;
    if (name === "@/lib/recording-status") return { sessionCaptureReport: () => null };
    if (name === "@/components/admin-dashboard") return { default: ({data}: {data:{sessions:{id:string}[]}}) =>
      jsxRuntime.jsx("main", {children: "Admin dashboard · " + data.sessions[0]?.id}) };
    if (name.startsWith("@/components/")) return { default: () => null };
    return {};
  } });
  const html = renderToStaticMarkup(await exports.default!({searchParams:Promise.resolve({recording})}));
  return {html,selections};
}

test("Admin renders its dashboard and focused recording when interruption columns are pending", async () => {
  const {html,selections} = await dashboard({code:"42703",message:"column recording_sessions.capture_interruption_code does not exist"});
  assert.match(html,new RegExp(`Admin dashboard · ${recording}`));
  assert.doesNotMatch(html,/Database setup needs attention/);
  assert.deepEqual(selections.map(fields=>fields.includes("capture_interruption_code")),[true,false,true,false]);
});

test("Admin still reports other database failures", async () => {
  const {html,selections} = await dashboard({code:"42501",message:"permission denied"});
  assert.match(html,/Admin data could not load/);
  assert.match(html,/Recording logs/);
  assert.doesNotMatch(html,/permission denied/);
  assert.ok(selections.every(fields=>fields.includes("capture_interruption_code")));
});

test("Admin calls out a database update only for a missing schema", async () => {
  const {html} = await dashboard({code:"PGRST205",message:"Private database schema details"});
  assert.match(html,/Database setup needs attention/);
  assert.doesNotMatch(html,/Private database schema details/);
});

async function readQueue(route: "admin/tablets" | "tablet", missing: string[], summary = false) {
  const path = new URL(`../app/api/${route}/route.ts`, import.meta.url);
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const exports: {GET?: (request: Request) => Promise<Response>} = {};
  const retryAt = "2026-11-13T04:00:00Z";
  const db = {from(table: string) {
    let projection = "";
    const result = () => {
      if (table === "browser_recordings") {
        assert.equal(summary, false, "Overview must skip the upload queue");
        const absent = missing.find(column => projection.includes(column));
        if (absent) return {data: null, error: {code: "42703", message: `column ${absent} does not exist`}};
        return {data: [{session_id: recording, upload_state: "retrying",
          ...(projection.includes("upload_retry_at") ? {upload_retry_at: retryAt} : {}),
          recording_sessions: {status: "uploading", ...(projection.includes("capture_interruption_code")
            ? {capture_interruption_code: "camera_disconnected"} : {})}}], error: null};
      }
      return {data: table === "venue_settings" ? {max_duration_seconds: 900} : [], error: null};
    };
    const query = {select: (value: string) => { projection = value; return query; },
      eq: () => query, order: () => query, limit: () => query,
      single: async () => result(), maybeSingle: async () => ({data: null, error: null}),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve)};
    return query;
  }};
  runInNewContext(compiled, {
    exports, URL, process: {env: {RECORDER_UPLOAD_BACKOFF_ENABLED: "true"}},
    require(name: string) {
      if (name === "@/lib/r2-server") return {usesR2: () => false};
      if (name === "@/lib/auth") return {getAccount: async () => ({account: {role: 'admin', tenantId: '00000000-0000-4000-8000-000000000001'}})};
      if (name === "@/lib/browser-tablets") return {browserTablet: async () => ({device: {id: "tablet"}, kiosk: {}}),
        publicTablet: (device: unknown) => device};
      if (name === "@/lib/recorder-server") return {recorderDatabase: () => db};
      if (name === "@/lib/team-recipients") return {normalizeRecipients: () => []};
      if (name === "@/lib/optional-schema") return optionalSchema;
      if (name === "@/lib/http") return {json: (body: unknown, status = 200) => Response.json(body, {status})};
      return {};
    },
  });
  const response = await exports.GET!(new Request(`http://127.0.0.1:3000/api/${route}${summary ? "?summary=1" : ""}`));
  assert.equal(response.status, 200);
  return response.json();
}

test("the Admin recorder summary omits recording and storage data", async () => {
  assert.deepEqual(await readQueue("admin/tablets", [], true), { devices: [] });
});

test("Admin and the recorder retain independently available queue fields during migrations", async () => {
  for (const missing of [[], ["capture_interruption_code"], ["upload_retry_at"],
    ["capture_interruption_code", "upload_retry_at"]]) {
    const [admin, tablet] = await Promise.all([readQueue("admin/tablets", missing), readQueue("tablet", missing)]);
    assert.equal(tablet.capabilities.uploadBackoffScheduling, !missing.includes("upload_retry_at"));
    for (const row of [admin.recordings[0], tablet.queue[0]]) {
      assert.equal(row.session_id, recording);
      assert.equal(row.upload_state, "retrying");
      assert.equal(row.upload_retry_at, missing.includes("upload_retry_at") ? undefined : "2026-11-13T04:00:00Z");
      assert.equal(row.recording_sessions.capture_interruption_code,
        missing.includes("capture_interruption_code") ? undefined : "camera_disconnected");
    }
  }
});
