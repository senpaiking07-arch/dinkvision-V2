import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const acknowledged = { upload_state: "failed", upload_updated_at: "2026-11-01T00:00:00+00:00" };

async function report(body: Record<string, unknown>) {
  const patches: Record<string, unknown>[] = [];
  const stateFilters: string[][] = [];
  const source = readFileSync(new URL("../app/api/tablet/route.ts", import.meta.url), "utf8");
  const exports: { POST?: (request: Request) => Promise<Response> } = {};
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, console,
    require(name: string) {
      if (name === "@/lib/browser-tablets") return {
        browserTablet: async () => ({ device: { id: "device" }, kiosk: { id: "kiosk" } }),
      };
      if (name === "@/lib/recorder-server") return { recorderDatabase: () => ({
        rpc: async () => ({ data: true, error: null }),
        from: () => {
          const query = {
            update: (patch: Record<string, unknown>) => { patches.push(patch); return query; },
            select: () => query, eq: () => query,
            in: (column: string, values: string[]) => {
              assert.equal(column, "upload_state");
              stateFilters.push(Array.from(values));
              return query;
            },
            maybeSingle: async () => ({ data: { session_id: "session" }, error: null }),
            single: async () => ({ data: acknowledged, error: null }),
          };
          return query;
        },
      }) };
      if (name === "@/lib/validation") return { uuid: (id: string) => id, InputError: class extends Error {} };
      if (name === "@/lib/http") return {
        sameOrigin: () => true,
        readBody: async () => ({ id: "session", ...body }),
        json: (body: unknown, status = 200) => Response.json(body, { status }),
      };
      return {};
    },
  });
  const response = await exports.POST!(new Request("https://localhost/api/tablet", { method: "POST" }));
  assert.equal(response.status, 200);
  return {response, patches, stateFilters};
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
