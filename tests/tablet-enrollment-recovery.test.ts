import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { enrollmentCode, enrollmentPin, legacyEnrollmentCode, qrVerifier } from "../lib/tablet-enrollment";
import * as optionalSchema from "../lib/optional-schema";

const source = ts.transpileModule(
  readFileSync(new URL("../app/api/tablet/enroll/route.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const venue = "11111111-1111-4111-8111-111111111111";
const code = "A".repeat(24);
const attempt = "B".repeat(43);
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

function fixture(qr = false, issuedCode = code) {
  const exports: { POST?: (request: Request) => Promise<Response> } = {};
  const issued = new Map<string, string>();
  const calls: Array<{ scope: string; args: Record<string, string> }> = [];
  let used = false, enabled = true, active = true, setupExpires = Date.now() + 60_000;
  let committed: Record<string, string> | undefined;
  let previous: { id: string; tenant_id: string } | null = null;
  function from(table: string) {
    const filters = new Map<string, unknown>();
    const query = {
      select: () => query,
      eq: (name: string, value: unknown) => { filters.set(name, value); return query; },
      contains: () => query,
      order: () => query,
      limit: () => query,
      single: async () => ({ data: { actor_id: "venue-admin" }, error: null }),
      maybeSingle: async () => {
        let data = null;
        if (table === "kiosk_devices" && active && committed?.p_token === filters.get("token_hash"))
          data = { id: "assigned-kiosk", tenant_id: venue };
        if (table === "browser_devices" && !used &&
          filters.get(qr ? "enrollment_qr_hash" : "enrollment_hash") === hash(issuedCode))
          data = { id: "assigned-device", tenant_id: venue };
        if (table === "browser_devices" && enabled && filters.get("kiosk_id") === "assigned-kiosk")
          data = { id: "assigned-device", setup_hash: committed?.p_setup, setup_expires_at: new Date(setupExpires).toISOString() };
        return { data, error: null };
      },
    };
    return query;
  }
  runInNewContext(source, {
    exports,
    process: { env: { NODE_ENV: "production", SUPABASE_SECRET_KEY: "test-only-server-secret" } },
    require(name: string) {
      if (name === "node:crypto") return crypto;
      if (name === "next/headers") return { cookies: async () => ({
        set: (key: string, value: string) => issued.set(key, value),
      }) };
      if (name === "@/lib/kiosk") return { hashKiosk: hash, kioskCookie: "cb-kiosk", kioskDevice: async () => previous };
      if (name === "@/lib/android-release") return { androidUpdateRequired: () => null };
      if (name === "@/lib/tablet-enrollment") return { enrollmentCode, enrollmentPin, legacyEnrollmentCode, qrVerifier };
      if (name === "@/lib/optional-schema") return optionalSchema;
      if (name === "@/lib/http") return {
        json: (body: unknown, status = 200) => Response.json(body, { status }),
        sameOrigin: (r: Request) => r.headers.get("origin") === "https://dinkvision.test",
        readBody: (r: Request) => r.json(),
      };
      if (name === "@/lib/recorder-server") return {
        systemDatabase: () => ({ from }),
        recorderDatabase: (scope: string) => ({
          from,
          rpc: async (name: string, args: Record<string, string>) => {
            assert.equal(name, qr ? "enroll_browser_qr" : "enroll_browser");
            calls.push({ scope, args });
            if (used) return { error: { code: "P0001" } };
            if (qr && args.p_hash !== hash(qrVerifier(code, "012345"))) return { data: null, error: null };
            used = true;
            committed = args;
            return { data: "assigned-kiosk", error: null };
          },
        }),
      };
      throw new Error(`Unexpected module ${name}`);
    },
  });
  return {
    calls, issued,
    setPrevious: (id: string) => { previous = { id, tenant_id: venue }; },
    expireSetup: () => { setupExpires = 0; },
    revoke: () => { enabled = false; active = false; },
    async submit(body: Record<string, unknown>, origin = "https://dinkvision.test") {
      issued.clear();
      return exports.POST!(new Request("https://dinkvision.test/api/tablet/enroll", {
        method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
      }));
    },
  };
}

test("a lost enrollment reply can be recovered with the same private attempt after setup expires", async () => {
  const f = fixture();
  assert.equal((await f.submit({ code, attempt, recover: true })).status, 404);
  assert.equal(f.calls.length, 0, "a recovery check cannot consume an unused code");
  assert.equal((await f.submit({ code, attempt })).status, 200);
  const deviceToken = f.issued.get("cb-kiosk")!;
  assert.match(deviceToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(f.calls[0].scope, venue);
  assert.equal(f.calls[0].args.p_token, hash(deviceToken));
  f.expireSetup();
  assert.equal((await f.submit({ code, attempt, recover: true })).status, 200);
  assert.equal(f.issued.get("cb-kiosk"), deviceToken);
  assert.equal(f.issued.get("cb-tablet-setup"), "");
  assert.equal(f.calls.length, 1, "the one-use transaction ran only once");
  f.setPrevious("another-active-kiosk");
  assert.equal((await f.submit({ code, attempt, recover: true })).status, 409);
  assert.equal(f.issued.size, 0);
});

test("another attempt, a foreign origin or a revoked registration cannot recover a credential", async () => {
  const f = fixture();
  assert.equal((await f.submit({ code, attempt })).status, 200);
  assert.equal((await f.submit({ code, attempt: "C".repeat(43), recover: true })).status, 404);
  assert.equal((await f.submit({ code, attempt: "C".repeat(43) })).status, 400);
  assert.equal((await f.submit({ code, attempt, recover: true }, "https://elsewhere.test")).status, 403);
  f.revoke();
  assert.equal((await f.submit({ code, attempt, recover: true })).status, 404);
  assert.equal(f.issued.size, 0);
  assert.equal(f.calls.length, 1);
});

test("code-only enrollment remains compatible with existing clients", async () => {
  const f = fixture();
  assert.equal((await f.submit({ code })).status, 200);
  assert.match(f.issued.get("cb-kiosk")!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await f.submit({ code })).status, 400);
  assert.equal(f.calls.length, 1);
});

test("a scanned pairing code and the same typed code compete for one registration", async () => {
  const code = "abcABC012_-z";
  const f = fixture(false, code);
  const attempts = [{code, attempt}, {code, attempt: "D".repeat(43)}];
  const results = await Promise.all(attempts.map(body => f.submit(body)));
  assert.equal(results.filter(result => result.ok).length, 1);
  const usedBy = attempts[results.findIndex(result => result.ok)];
  assert.equal((await f.submit({...usedBy, recover: true})).status, 200);
  assert.equal((await f.submit({code, attempt: "E".repeat(43)})).status, 400);
});

test("a QR invitation alone cannot enroll and the PIN remains separate from the stored hash", async () => {
  const f = fixture(true);
  assert.equal((await f.submit({ code })).status, 400);
  assert.equal((await f.submit({ invite: code })).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.submit({ invite: code, pin: "123456", attempt })).status, 400);
  assert.equal(f.issued.size, 0);
  assert.equal((await f.submit({ invite: code, pin: "012345", attempt })).status, 200);
  assert.equal(f.calls[1].args.p_invite, hash(code));
  assert.equal(f.calls[1].args.p_hash, hash(qrVerifier(code, "012345")));
  const token = f.issued.get("cb-kiosk");
  assert.equal((await f.submit({ invite: code, pin: "012345", attempt, recover: true })).status, 200);
  assert.equal(f.issued.get("cb-kiosk"), token);
  assert.equal(f.calls.length, 2);
});
