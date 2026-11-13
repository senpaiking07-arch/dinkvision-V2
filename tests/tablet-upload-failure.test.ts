import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { isCaptureInterruption } from "../lib/capture-interruption";
import * as optionalSchema from "../lib/optional-schema";

const acknowledged = { upload_state: "failed", upload_updated_at: "2026-11-01T00:00:00+00:00" };

async function report(body: Record<string, unknown>, backoff = false, owned = true, inspectionRequired = false, legacy = false, missingRetryColumn = false) {
  const patches: Record<string, unknown>[] = [];
  const stateFilters: string[][] = [];
  const operations: string[] = [];
  const sessionFilters: unknown[][] = [];
  const source = readFileSync(new URL("../app/api/tablet/route.ts", import.meta.url), "utf8");
  const exports: { POST?: (request: Request) => Promise<Response> } = {};
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, console, process: { env: { RECORDER_UPLOAD_BACKOFF_ENABLED: backoff ? "true" : "false" } },
    require(name: string) {
      if (name === "@/lib/browser-tablets") return {
        browserTablet: async () => ({ device: { id: "device" }, kiosk: { id: "kiosk" } }),
      };
      if (name === "@/lib/recorder-server") return { recorderDatabase: () => ({
        rpc: async (name: string) => {
          operations.push(name);
          return { data: name !== "hold_short_browser_recording" && name !== "hold_unsupported_browser_recording", error: null };
        },
        from: (table: string) => {
          let fields = "";
          let patchBody: Record<string, unknown> = {};
          const query = {
            update: (patch: Record<string, unknown>) => {
              patchBody = patch;
              if (table !== "browser_devices") { operations.push(table); patches.push(patch); }
              return query;
            },
            select: (columns: string) => { fields = columns; return query; },
            eq: (column: string, value: unknown) => {
              if (table === "recording_sessions") sessionFilters.push([column, value]);
              return query;
            },
            is: (column: string, value: unknown) => { sessionFilters.push([column, value]); return query; },
            in: (column: string, values: string[]) => {
              if (table === "recording_sessions") return query;
              assert.equal(column, "upload_state");
              stateFilters.push(Array.from(values));
              return query;
            },
            maybeSingle: async () => legacy && fields.includes("capture_inspection_required")
              ? {data: null, error: {code: "42703", message: "column recording_sessions.capture_inspection_required does not exist"}}
              : ({
              data: owned ? { session_id: "session", recording_sessions: { capture_inspection_required: inspectionRequired } } : null,
              error: null,
            }),
            single: async () => ({ data: acknowledged, error: null }),
            then: (resolve: (value: unknown) => unknown) => Promise.resolve({
              error: missingRetryColumn && "upload_retry_at" in patchBody
                ? {code: "PGRST204", message: "Could not find the 'upload_retry_at' column"} : null,
            }).then(resolve),
          };
          return query;
        },
      }) };
      if (name === "@/lib/validation") return { uuid: (id: string) => id, InputError: class extends Error {} };
      if (name === "@/lib/capture-interruption") return { isCaptureInterruption };
      if (name === "@/lib/optional-schema") return optionalSchema;
      if (name === "@/lib/http") return {
        sameOrigin: () => true,
        readBody: async () => ({ id: "session", ...body }),
        json: (body: unknown, status = 200) => Response.json(body, { status }),
      };
      return {};
    },
  });
  const response = await exports.POST!(new Request("https://localhost/api/tablet", { method: "POST" }));
  return {response, patches, stateFilters, operations, sessionFilters};
}

test("a delayed branded-save report can update only an idle or still-saved row", async () => {
  const {response, stateFilters} = await report({action: "queue-report", status: "saved_locally", branding_state: "complete"});
  assert.deepEqual(await response.json(), {ok: true});
  assert.deepEqual(stateFilters, [["idle", "saved_locally"]]);
});

test("validation failures keep a precise recovery message and acknowledge the server state", async () => {
  const {response, patches} = await report({ action: "upload-failed", retry_count: 1,
    retrying: false, validation_failed: true, local_available: false, branding_state: "failed", last_error: "Saved audio ends early." });
  assert.deepEqual(await response.json(), { ok: true, ...acknowledged });
  const failurePatch=patches.find(p=>p.safe_error);
  assert.equal(failurePatch?.safe_error, "Video validation failed. Check the saved video on the original device.");
  assert.equal(failurePatch?.upload_state, undefined, "validation must not schedule a connection retry");
  assert.equal(failurePatch?.local_available, false, "a missing-file report must reach Admin");
});

test("automatic retry reports use a bounded server-relative cooldown only when enabled", async () => {
  const body = { action: "upload-failed", retry_count: 1, retrying: true, retry_delay_ms: 60_000 };
  const started = Date.now();
  const enabled = await report(body, true);
  const patch = enabled.patches.find(p => p.upload_state === "retrying");
  const retryAt = Date.parse(String(patch?.upload_retry_at));
  assert.ok(retryAt >= started + 60_000 && retryAt <= Date.now() + 60_000);
  const legacy = await report(body);
  assert.equal(legacy.patches.some(p => "upload_retry_at" in p), false);
});

test("upload failures remain reportable while the retry migration is pending", async () => {
  const {response, patches, operations} = await report(
    {action: "upload-failed", retry_count: 1, retrying: true, retry_delay_ms: 60000}, true, true, false, false, true,
  );
  assert.deepEqual(await response.json(), {ok: true, ...acknowledged});
  assert.equal(operations.filter(operation => operation === "report_browser_upload").length, 1);
  assert.equal(patches.at(-1)?.upload_state, "retrying");
  assert.equal("upload_retry_at" in patches.at(-1)!, false);
});

test("a recovered save persists the first capture report before making the file uploadable", async () => {
  const {response, patches, operations, sessionFilters} = await report({
    action: "saved", bytes: 1000, mime: "video/mp4", duration_ms: 84_000,
    capture_interruption_code: "camera_disconnected", capture_interrupted_at: 1_750_000_000_000,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(operations, ["recording_sessions", "browser_event", "hold_short_browser_recording",
    "hold_unsupported_browser_recording", "queue_browser_upload"]);
  assert.equal(patches[0].capture_interruption_code, "camera_disconnected");
  assert.equal(patches[0].capture_interrupted_at, new Date(1_750_000_000_000).toISOString());
  assert.deepEqual(sessionFilters, [["id", "session"], ["kiosk_id", "kiosk"], ["capture_interruption_code", null]]);
});

test("interruption reporting checks ownership, known codes, timestamp and recovered duration", async () => {
  const fields = { action: "saved", capture_interruption_code: "unknown", duration_ms: 84_000 };
  const foreign = await report(fields, false, false);
  assert.equal(foreign.response.status, 403);
  assert.deepEqual(foreign.operations, []);
  for (const invalid of [
    { capture_interruption_code: "<script>" }, { capture_interruption_code: "constructor" },
    { capture_interrupted_at: "yesterday" }, { capture_interrupted_at: Number.MAX_SAFE_INTEGER },
    { duration_ms: undefined },
  ]) {
    const response = await report({ ...fields, ...invalid });
    assert.equal(response.response.status, 400);
    assert.deepEqual(response.operations, []);
  }
  const restarted = await report({ action: "failed", capture_interruption_code: "app_interrupted" });
  assert.equal(restarted.patches[0].capture_interrupted_at, null);
  assert.equal(restarted.patches[1].capture_inspection_required, true);
  const uploadFailure = await report({ action: "upload-failed", capture_interruption_code: "unknown" });
  assert.equal(uploadFailure.patches.some(p => "capture_interruption_code" in p), false);
  const older = await report({ action: "saved", bytes: 1000, mime: "video/mp4" });
  assert.equal(older.response.status, 200);
  assert.equal(older.operations.includes("recording_sessions"), false);
});

test("an inspection-only interrupted recording can report recovery metadata but cannot enter Drive delivery", async () => {
  for (const action of ["saved", "upload", "finish", "retry-upload", "restart-upload"]) {
    const {response, operations} = await report({action}, false, true, true);
    assert.equal(response.status, 409);
    assert.deepEqual(operations, []);
  }
  const failed = await report({action: "upload-failed", validation_failed: true, capture_interruption_code: "camera_disconnected"});
  assert.equal(failed.response.status, 200);
  assert.equal(failed.patches[1].capture_inspection_required, true);
  assert.equal(failed.operations[2], "browser_event");
});

test("a pre-migration database still supports normal recording and can release an interrupted capture", async () => {
  const normal = await report({action: "saved", bytes: 1000, mime: "video/mp4", duration_ms: 84_000}, false, true, false, true);
  assert.equal(normal.response.status, 200);
  assert.ok(normal.operations.includes("queue_browser_upload"));
  const captured = await report({action: "captured", capture_interruption_code: "unknown"}, false, true, false, true);
  assert.equal(captured.response.status, 200);
  assert.deepEqual(captured.operations, ["browser_event"]);
  const interrupted = await report({action: "saved", bytes: 1000, mime: "video/mp4", duration_ms: 84_000,
    capture_interruption_code: "unknown"}, false, true, false, true);
  assert.equal(interrupted.response.status, 503);
  assert.deepEqual(interrupted.operations, []);
  assert.match((await interrupted.response.json()).error, /database update/);
});
