import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../app/api/tablet/camera/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function confirm(options: { stale?: boolean; status?: string; rpcData?: boolean; rpcError?: boolean } = {}) {
  let rpcCalls = 0;
  const exports: { POST?: (request: Request) => Promise<Response> } = {};
  runInNewContext(compiled, {
    exports, console: { error() {} },
    require(name: string) {
      if (name === "@/lib/browser-tablets") return {
        browserTablet: async () => ({
          device: { recorder_mode: "android_rtsp", video_device: "android-camera-v1", config_revision: "current" },
          kiosk: { id: "kiosk", current_session_id: options.status ? "session" : null },
        }),
      };
      if (name === "@/lib/recorder-server") return { recorderDatabase: () => ({
        from: () => {
          const query = { select: () => query, eq: () => query,
            maybeSingle: async () => ({ data: { status: options.status }, error: null }) };
          return query;
        },
        rpc: async () => {
          rpcCalls++;
          return { data: options.rpcData ?? true, error: options.rpcError ? { code: "08006" } : null };
        },
      }) };
      if (name === "@/lib/validation") return { uuid: (id: string) => id, InputError: class extends Error {} };
      if (name === "@/lib/http") return {
        sameOrigin: () => true,
        readBody: async () => ({ action: "tested", revision: options.stale ? "old" : "current", passed: true }),
        json: (body: unknown, status = 200) => Response.json(body, { status }),
      };
      return {};
    },
  });
  const response = await exports.POST!(new Request("https://localhost/api/tablet/camera", { method: "POST" }));
  return { status: response.status, body: await response.json(), rpcCalls };
}

test("a stale camera clip directs the tester to record another test", async () => {
  const result = await confirm({ stale: true });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /settings changed.*Record another test/);
  assert.equal(result.rpcCalls, 0);
});

test("active captures block confirmation while older uploads do not", async () => {
  for (const status of ["requested", "starting", "recording", "finalizing"]) {
    const result = await confirm({ status });
    assert.equal(result.status, 409, status);
    assert.match(result.body.error, /Finish it/);
    assert.equal(result.rpcCalls, 0);
  }
  for (const status of [undefined, "uploading", "sharing", "ready", "failed"]) {
    const result = await confirm({ status });
    assert.equal(result.status, 200, status);
    assert.equal(result.rpcCalls, 1);
  }
});

test("connection failure and a concurrent state change have different recovery actions", async () => {
  const connection = await confirm({ rpcError: true });
  assert.equal(connection.status, 503);
  assert.match(connection.body.error, /connection.*confirming again/);
  const conflict = await confirm({ rpcData: false });
  assert.equal(conflict.status, 409);
  assert.match(conflict.body.error, /Record another test.*idle/);
});
