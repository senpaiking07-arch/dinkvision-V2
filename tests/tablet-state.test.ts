import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {venueStateError} from "../lib/venue-errors";

// Isolate request-bound Next imports while exercising the actual route handler,
// including rejected promises returned by its asynchronous state loader.
function handler(error: { code: string; message: string }, enrolled = true) {
  const source = readFileSync(new URL("../app/api/tablet/route.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { GET?: (request: Request) => Promise<Response> } = {};
  runInNewContext(compiled, {
    exports, URL,
    console: { error() {} },
    require(name: string) {
      if (name === "@/lib/venue-errors") return {venueStateError};
      if (name === "@/lib/browser-tablets") return {
        browserTablet: async () => enrolled ? { device: { id: "device" }, kiosk: {} } : null,
      };
      if (name === "@/lib/recorder-server") return {
        recorderDatabase: () => ({ rpc: async () => ({ error }) }),
      };
      if (name === "@/lib/http") return { json: (body: unknown, status = 200) => Response.json(body, {status}) };
      return {};
    },
  });
  return exports.GET!;
}

test("tablet setup returns actionable JSON when its queue migration is missing", async () => {
  const response = await handler({code:"PGRST202",message:"Missing RPC"})(new Request("http://localhost/api/tablet?setup=1"));
  assert.equal(response.status,503);
  assert.match((await response.json()).error,/202610130033_recording_queue_recovery.sql/);
});

test("asynchronous tablet state failures stay inside the JSON error handler", async () => {
  const response = await handler({code:"08006",message:"Internal database details"})(new Request("http://localhost/api/tablet?setup=1"));
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:"Tablet connection unavailable. Please retry."});
});

test("unenrolled browser still receives the setup enrollment response", async () => {
  const response = await handler({code:"PGRST202",message:"Missing RPC"},false)(new Request("http://localhost/api/tablet?setup=1"));
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{enabled:false});
});
