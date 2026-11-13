import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { DriveError, uploadUri } from "../lib/google-drive";

const address = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=fixture-only";
const source = ts.transpileModule(readFileSync("lib/browser-upload.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  const recording: any = { session_id: "session", device_id: "device", file_id: "local12345",
    bytes: 5000000, mime_type: "video/mp4", upload_state: "uploading", drive_id: "drive12345",
    folder_id: "folder12345", root_id: "root12345", upload_uri_encrypted: "sealed:" + address };
  const state = { allowed: true, remote: null as any, probes: 0, reports: [] as any[], grants: 0 };
  const db = {
    async rpc(name: string, body: any) {
      if (name === "browser_upload_turn") return { data: [{ allowed: state.allowed,
        upload_state: state.allowed ? "uploading" : "queued", queue_position: 1 }], error: null };
      state.reports.push({ name, ...body }); return { data: true, error: null };
    },
    from(table: string) {
      const filters: Record<string, any> = {}; let patch: any;
      function result() {
        if (table === "recording_sessions") return { data: { id: "session", status: "uploading",
          started_at: "2026-11-03T00:00:00Z", recipient_email: "fixture@example.invalid",
          configuration_snapshot: { court_name: "Fixture court", venue_time_zone: "Asia/Manila" } }, error: null };
        const owned = !filters.device_id || filters.device_id === recording.device_id;
        if (owned && patch) Object.assign(recording, patch);
        return { data: owned ? { ...recording } : null, error: null };
      }
      const query: any = { select: () => query, eq: (key: string, value: any) => { filters[key] = value; return query; },
        or: () => query, update: (value: any) => { patch = value; return query; },
        single: async () => result(), maybeSingle: async () => result(),
        then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject) };
      return query;
    },
  };
  const exports: any = {};
  runInNewContext(source, {
    exports, URL, Date, Uint8Array, AbortSignal,
    fetch: async (_url: string, options: RequestInit) => {
      assert.equal(options.body instanceof Uint8Array, true);
      assert.equal((options.body as Uint8Array).byteLength, 0, "status probes must not relay video data");
      state.probes++; return new Response(null, { status: 308, headers: { Range: "bytes=0-1048575" } });
    },
    require(name: string) {
      if (name === "server-only") return {};
      if (name === "node:crypto") return { randomUUID: () => "lease" };
      if (name === "./recorder-server") return { recorderDatabase: () => db };
      if (name === "./google-drive") return { DriveError, uploadUri, localDay: () => "2026-11-03", recordingFileName: () => "fixture.mp4" };
      if (name === "./google-crypto") return { encryptSecret: (s: string) => "sealed:" + s, decryptSecret: (s: string) => s.slice(7) };
      if (name === "./google-server") return { connectedDrive: async () => ({
        integration: { root_folder_id: "root12345", owner_email: "owner@example.invalid" },
        drive: { privateFolder: async () => {}, file: async () => {
          if (!state.remote) throw new DriveError("drive_file_missing"); return state.remote;
        }, beginUpload: async () => { state.grants++; return address; }, shareLink: async () => "permission" },
      }) };
      throw Error("Unexpected fixture dependency: " + name);
    },
  });
  return { api: exports, recording, state };
}

test("opted-in uploads receive a scoped Drive session; ordinary browser responses do not", async () => {
  const f = fixture();
  const direct = await f.api.browserUpload("session", "device", false, true);
  assert.equal(direct.directUpload?.url, address, "APK needs a direct destination instead of the Vercel chunk relay");
  assert.equal(direct.directUpload.bytes, f.recording.bytes);
  assert.equal(direct.directUpload.mime, "video/mp4");
  assert.equal(JSON.stringify(direct).includes("sealed:"), false);
  const legacy = await f.api.browserUpload("session", "device");
  assert.equal(legacy.directUpload, undefined);
  assert.equal(JSON.stringify(legacy).includes("upload_id"), false);
});

test("new Drive sessions remain encrypted at rest and return only to their owning queue turn", async () => {
  const f = fixture(); f.recording.upload_uri_encrypted = null;
  const created = await f.api.browserUpload("session", "device", false, true);
  assert.equal(created.directUpload?.url, address); assert.equal(f.state.grants, 1);
  assert.equal(f.recording.upload_uri_encrypted, "sealed:" + address);
  f.state.allowed = false;
  const queued = await f.api.browserUpload("session", "device", false, true);
  assert.equal(queued.queued, true); assert.equal(queued.directUpload, undefined);
  f.state.allowed = true;
  await assert.rejects(() => f.api.browserUpload("session", "other-device", false, true));
});

test("unsafe destinations are rejected and upload finish remains server verified", async () => {
  const f = fixture(); f.recording.upload_uri_encrypted = "sealed:https://attacker.invalid/upload";
  await assert.rejects(() => f.api.browserUpload("session", "device", false, true));
  f.recording.upload_uri_encrypted = "sealed:" + address;
  await assert.rejects(() => f.api.browserUpload("session", "device", true, true), /not complete/);
  f.state.remote = { size: 1, mimeType: "video/mp4", parents: ["folder12345"] };
  await assert.rejects(() => f.api.browserUpload("session", "device", true, true), /did not match/);
  f.state.remote.size = f.recording.bytes;
  const complete = await f.api.browserUpload("session", "device", true, true);
  assert.equal(complete.ready, true); assert.equal(complete.directUpload, undefined);
  assert.ok(f.state.reports.some(r => r.name === "finish_browser_upload"));
});

test("Drive-confirmed offsets update Admin through empty-body probes", async () => {
  const f = fixture();
  const progress = await f.api.browserUploadStatus("session", "device");
  assert.equal(progress.offset, 1048576); assert.equal(f.state.probes, 1);
  assert.ok(f.state.reports.some(r => r.p_uploaded_bytes === 1048576));
});

test("tablet route requires device ownership before forwarding an explicit direct-upload opt-in", async () => {
  const optionalSchema = await import("../lib/optional-schema");
  const routeSource = ts.transpileModule(readFileSync("app/api/tablet/route.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const scenario of [
    { action: "upload", optIn: true, status: 200, direct: true },
    { action: "retry-upload", optIn: true, status: 200, direct: true },
    { action: "restart-upload", optIn: true, status: 200, direct: true },
    { action: "finish", optIn: true, status: 200, direct: true },
    { action: "upload", optIn: undefined, status: 200, direct: false },
    { action: "upload", optIn: "true", status: 200, direct: false },
    { action: "upload", optIn: true, status: 401, unenrolled: true },
    { action: "upload", optIn: true, status: 403, foreign: true },
    { action: "upload", optIn: true, status: 403, wrongOrigin: true },
  ]) {
    const exports: any = {}, calls: any[] = [];
    runInNewContext(routeSource, { exports, URL, console: { error() {} }, require(name: string) {
      if (name === "@/lib/optional-schema") return optionalSchema;
      if (name === "@/lib/browser-tablets") return { browserTablet: async () => scenario.unenrolled ? null :
        ({ device: { id: "device" }, kiosk: { id: "kiosk", tenant_id: "tenant" } }) };
      if (name === "@/lib/recorder-server") return { recorderDatabase: () => ({
        rpc: async () => ({ data: true, error: null }), from: () => {
          const result = { data: scenario.foreign ? null : { session_id: "session" }, error: null };
          const q: any = { update: () => q, eq: () => q, or: () => q, select: () => q,
            maybeSingle: async () => result, then: (yes: any) => Promise.resolve(result).then(yes) }; return q;
        },
      }) };
      if (name === "@/lib/http") return { sameOrigin: () => !scenario.wrongOrigin,
        readBody: async () => ({ action: scenario.action, id: "session", direct_upload: scenario.optIn }),
        json: (body: any, status = 200) => Response.json(body, { status }) };
      if (name === "@/lib/validation") return { uuid: (id: string) => id, InputError: class extends Error {} };
      if (name === "@/lib/browser-upload") return { browserUpload: async (...args: any[]) => {
        calls.push(args); return { ready: false, queued: false };
      } };
      return {};
    } });
    const response = await exports.POST(new Request("https://dinkvision.vercel.app/api/tablet", { method: "POST" }));
    assert.equal(response.status, scenario.status, JSON.stringify(scenario));
    if (scenario.status === 200) assert.deepEqual(calls, [["session", "device", scenario.action === "finish", scenario.direct]]);
    else assert.equal(calls.length, 0, "unauthorized clients must never receive a Drive session");
  }
});
