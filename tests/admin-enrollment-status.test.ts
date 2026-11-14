import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { pairingCode } from "../lib/tablet-enrollment";
import { DEFAULT_TENANT_ID, TENANT_COOKIE } from "../lib/tenant-scope";
import { InputError, uuid } from "../lib/validation";

const route = ts.transpileModule(
  readFileSync("app/api/admin/tablets/enrollment-status/route.ts", "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const id = "11111111-1111-4111-8111-111111111111";
const code = "Abc012_de-Fg";
const hashKiosk = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture({ admin = true, venueAdmin = true, databaseError = false } = {}) {
  const exports: { POST?: (request: Request) => Promise<Response> } = {};
  let reads = 0;
  let data: Record<string, unknown> | null = {
    enabled: true,
    enrollment_hash: hashKiosk(code),
    enrollment_expires_at: new Date(Date.now() + 60_000).toISOString(),
    consumed_enrollment_hash: null,
  };
  runInNewContext(route, { exports, require(name: string) {
    switch (name) {
      case "next/headers": return { cookies: async () => ({ get: () => undefined }) };
      case "@/lib/auth": return { getAccount: async () => ({ account: { role: admin ? "admin" : "player" } }) };
      case "@/lib/http": return {
        sameOrigin: (request: Request) => request.headers.get("origin") === "https://app.test",
        readBody: (request: Request) => request.json(),
        json: (body: unknown, status = 200) => Response.json(body, { status }),
      };
      case "@/lib/kiosk": return { hashKiosk };
      case "@/lib/validation": return { InputError, uuid };
      case "@/lib/tablet-enrollment": return { pairingCode };
      case "@/lib/tenant-scope": return { DEFAULT_TENANT_ID, TENANT_COOKIE };
      case "@/lib/supabase-server": return { serverSupabase: async (tenant: string) => {
        assert.equal(tenant, DEFAULT_TENANT_ID);
        return { rpc: async (functionName: string) => {
          assert.equal(functionName, "is_admin");
          return { data: venueAdmin };
        } };
      } };
      case "@/lib/recorder-server": return { recorderDatabase: (tenant: string) => {
        assert.equal(tenant, DEFAULT_TENANT_ID);
        return { from: (table: string) => {
          assert.equal(table, "browser_devices");
          return { select: () => ({ eq: (key: string, value: string) => {
            assert.equal(key, "id");
            assert.equal(value, id);
            return { maybeSingle: async () => {
              reads++;
              return { data, error: databaseError ? new Error("internal error") : null };
            } };
          } }) };
        } };
      } };
      default: throw new Error(name);
    }
  } });
  return {
    reads: () => reads,
    setData: (row: typeof data) => { data = row; },
    post: (submitted = code, origin = "https://app.test") => exports.POST!(new Request(
      "https://app.test/api/admin/tablets/enrollment-status", {
        method: "POST", headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ id, code: submitted }),
      },
    )),
  };
}

test("pairing status confirms only the consumed invitation", async () => {
  const f = fixture();
  assert.deepEqual(await (await f.post()).json(), { status: "pending" });
  assert.deepEqual(await (await f.post("Z".repeat(12))).json(), { status: "unavailable" });
  f.setData({ enabled: true, enrollment_hash: null, consumed_enrollment_hash: hashKiosk(code) });
  assert.deepEqual(await (await f.post()).json(), { status: "paired" });
  f.setData({ enabled: true, enrollment_hash: hashKiosk(code), enrollment_expires_at: "2000-01-01T00:00:00Z" });
  assert.deepEqual(await (await f.post()).json(), { status: "unavailable" });
  f.setData({ enabled: false, consumed_enrollment_hash: hashKiosk(code) });
  assert.deepEqual(await (await f.post()).json(), { status: "unavailable" });
  f.setData(null);
  assert.deepEqual(await (await f.post()).json(), { status: "unavailable" });
});

test("pairing status requires same-origin venue Admin access and handles database outages", async () => {
  for (const f of [fixture({ admin: false }), fixture({ venueAdmin: false })]) {
    assert.equal((await f.post()).status, 403);
    assert.equal(f.reads(), 0);
  }
  const f = fixture();
  assert.equal((await f.post(code, "https://other.test")).status, 403);
  assert.equal((await f.post("short")).status, 400);
  assert.equal(f.reads(), 0);
  assert.equal((await fixture({ databaseError: true }).post()).status, 503);
});
