import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { isNewRecordingTransition } from "../lib/recording-transition";
import { uuid } from "../lib/validation";

const tenantId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";

function load(path: string, modules: Record<string, unknown>, globals: object = {}) {
  const exports: Record<string, any> = {};
  const source = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { exports, URL, URLSearchParams, Response,
    require: (name: string) => modules[name], ...globals });
  return exports;
}

test("dashboard endpoint checks origin, user and venue before releasing a token or snapshot", async () => {
  let account: { id: string; tenantId: string; role: string } | null = { id: accountId, tenantId, role: "admin" };
  let tokenUser = accountId;
  let flag = "true";
  const { GET, POST } = load("app/api/admin/dashboard-snapshot/route.ts", {
    "@/lib/auth": { getAccount: async () => ({ account }) },
    "@/lib/admin-dashboard-snapshot": { loadAdminDashboard: async (venue: string, recording: string) => ({ data: { venue, recording }, failures: [] }) },
    "@/lib/http": { json: (data: unknown, status = 200) => Response.json(data, { status }), sameOrigin: (r: Request) => r.headers.get("origin") === "https://example.test" },
    "@/lib/validation": { uuid },
    "@/lib/supabase-server": { serverSupabase: async () => ({ auth: { getSession: async () => ({
      data: { session: { expires_at: 1000, access_token: "user-jwt", user: { id: tokenUser } } },
    }) } }) },
  }, { process: { env: { get DINKVISION_ADMIN_REALTIME() { return flag; } } } });
  const url = `https://example.test/api/admin/dashboard-snapshot?tenant=${tenantId}&account=${accountId}`;
  const post = (origin = "https://example.test") => POST(new Request(url, { method: "POST", headers: { origin } }));
  assert.equal((await post("https://elsewhere.test")).status, 403);
  assert.equal((await GET(new Request(url + "&recording=invalid"))).status, 400);
  assert.deepEqual(await (await GET(new Request(url))).json(), { venue: tenantId, recording: "" });
  assert.equal((await post()).status, 200);
  tokenUser = tenantId;
  assert.equal((await post()).status, 401);
  account.role = "player";
  assert.equal((await post()).status, 403);
  account = { ...account, role: "admin", tenantId: accountId };
  assert.equal((await GET(new Request(url))).status, 403);
  account = null;
  assert.equal((await GET(new Request(url))).status, 401);
  flag = "false";
  assert.equal((await post()).status, 404);
});

test("one private subscription coalesces hints, falls back and cleans up across visibility and access loss", async () => {
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = new EventTarget();
  const navigator = { onLine: true };
  const timers = new Map<number,{ fn: () => void; delay: number }>();
  let serial = 0, statusCode = 200, reads = 0, joins = 0, closes = 0, refreshes = 0, teardowns = 0;
  let cleanup: () => void = () => {};
  let status: (value: string) => void = () => {};
  let event: (value: { payload: unknown }) => void = () => {};
  let authenticated = false;
  const now = Date.now();
  const { useAdminRealtime } = load("components/use-admin-realtime.ts", {
    react: { useState: (initial: unknown) => [initial, () => {}], useEffect: (fn: () => () => void) => { cleanup = fn(); } },
    "@/lib/recording-transition": { isNewRecordingTransition },
    "@supabase/supabase-js": { createClient: () => ({
      realtime: {
        setAuth: async (token: string) => { authenticated = token === "jwt"; },
        getChannels: () => [{ teardown: () => { teardowns++; } }],
        disconnect: async () => { closes++; },
      },
      channel: (topic: string, options: { config: { private: boolean } }) => {
        assert.equal(topic, `tenant:${tenantId}:admin-status`);
        assert.ok(authenticated && options.config.private);
        joins++;
        return { on: (_kind: string, _config: object, callback: typeof event) => {
          event = callback;
          return { subscribe: (callback: typeof status) => { status = callback; } };
        } };
      },
    }) },
  }, {
    AbortController, AbortSignal, document, window, navigator,
    Date: class extends Date { static now() { return now; } },
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://example.test", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable" } },
    fetch: async (_url: string, options: RequestInit) => {
      if (options.method === "POST") return Response.json({ accessToken: "jwt", expiresAt: now/1000 + 3600 });
      reads++;
      return Response.json({ sessions: [] }, { status: statusCode });
    },
    setTimeout: (fn: () => void, delay: number) => { timers.set(++serial, { fn, delay }); return serial; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  async function fire(min: number, max: number) {
    const matches = [...timers].filter(([,timer]) => timer.delay >= min && timer.delay <= max);
    assert.equal(matches.length, 1);
    const [id, timer] = matches[0];
    timers.delete(id);
    timer.fn();
    await flush();
  }
  useAdminRealtime({}, { tenantId, accountId }, "", () => { refreshes++; });
  await flush();
  assert.equal(reads, 0);
  assert.equal(joins, 1);
  assert.ok([...timers.values()].some(timer => timer.delay === 30000));
  status("SUBSCRIBED");
  await fire(0,5000);
  const hint = { schemaVersion: 1, type: "recording.transition", tenantId, entityId: accountId, eventId: accountId, version: 3, occurredAt: "2026-11-24T10:00:00Z" };
  event({ payload: hint });
  await fire(0,5000);
  event({ payload: hint });
  event({ payload: { ...hint, version: 2 } });
  assert.equal(reads, 2);
  assert.ok([...timers.values()].some(timer => timer.delay === 60000));
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(closes, 1);
  assert.equal(teardowns, 1);
  assert.equal(timers.size, 0);
  document.hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  assert.equal(joins, 2);
  status("CHANNEL_ERROR");
  assert.ok([...timers.values()].some(timer => timer.delay === 30000));
  for (const delay of [1000, 2000, 4000, 8000, 16000]) {
    await fire(delay, delay);
    status("SUBSCRIBED");
    status("CHANNEL_ERROR");
    await fire(5000, 5000);
  }
  assert.equal(joins, 7);
  assert.deepEqual([...timers.values()].map(timer => timer.delay), [30000]);
  const readsBeforePoll = reads;
  await fire(30000, 30000);
  assert.equal(reads, readsBeforePoll + 1);
  navigator.onLine = false;
  window.dispatchEvent(new Event("offline"));
  assert.equal(timers.size, 0);
  navigator.onLine = true;
  statusCode = 401;
  window.dispatchEvent(new Event("online"));
  await flush();
  assert.equal(refreshes, 1);
  assert.equal(joins, 7);
  cleanup();
  assert.equal(timers.size, 0);
});
