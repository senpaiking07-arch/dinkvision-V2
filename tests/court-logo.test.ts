import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import sharp from "sharp";
import ts from "typescript";
import * as courtLogo from "../lib/court-logo";
import * as validation from "../lib/validation";

async function image() {
  // Two pixels make it possible to check that opaque artwork and alpha both survive.
  return sharp(Buffer.from([200, 30, 20, 255, 0, 0, 0, 0]), {
    raw: { width: 2, height: 1, channels: 4 },
  }).webp({ lossless: true }).toBuffer();
}

test("recording logo normalization preserves alpha and bounds decoded input", async () => {
  const request = (bytes: Buffer) => new Request("https://test.invalid", { method: "POST", body: new Uint8Array(bytes) });
  const result = await courtLogo.normalizeCourtLogo(request(await image()));
  const decoded = await sharp(result).raw().toBuffer();
  assert.deepEqual([...decoded], [200, 30, 20, 255, 0, 0, 0, 0]);
  await assert.rejects(courtLogo.normalizeCourtLogo(request(Buffer.alloc(2 * 1024 * 1024 + 1))), /2 MB/);
  await assert.rejects(courtLogo.normalizeCourtLogo(request(Buffer.from("broken"))), validation.InputError);
  const huge = await sharp({create: {width:2001,height:2000,channels:3,background:"red"}}).png().toBuffer();
  await assert.rejects(courtLogo.normalizeCourtLogo(request(huge)), /4 megapixels/);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  await assert.rejects(courtLogo.normalizeCourtLogo(request(svg)), validation.InputError);
  const large = await sharp({create: {width:1024,height:512,channels:3,background:"red"}}).jpeg().toBuffer();
  const resized = await sharp(await courtLogo.normalizeCourtLogo(request(large))).metadata();
  assert.deepEqual([resized.width,resized.height],[512,256]);
});

test("only admins can edit a court logo and only its owning recorder can fetch the reserved version", async () => {
  const tenant = randomUUID(), court = randomUUID(), session = randomUUID();
  const kiosk = randomUUID(), device = randomUUID();
  let role = "admin", enrolled = true, reserved: string | undefined;
  let saved: {court_id: string; version: string; png: string} | undefined;
  function database(scope: string) {
    assert.equal(scope, tenant);
    return { from(table: string) {
      const filters: Record<string, string> = {};
      const query = {
        select: () => query,
        eq: (key: string,value: string) => { filters[key] = value; return query; },
        delete: () => ({eq: async (key: string,value: string) => {
          assert.equal(table,"court_recording_logos");
          assert.equal(key,"court_id");
          assert.equal(value,court);
          saved = undefined;
          return {};
        }}),
        upsert: async (data: NonNullable<typeof saved>) => { assert.equal(data.court_id,court); saved = data; return {}; },
        maybeSingle: async () => {
          if (table === "courts") return {data:filters.id === court ? {id:court} : null};
          if (table === "recording_sessions") return {data:filters.id === session && filters.kiosk_id === kiosk
            ? {court_id:court, configuration_snapshot:{device_id:device,court_logo_version:reserved}} : null};
          assert.equal(filters.court_id,court);
          return {data:!filters.version || filters.version === saved?.version ? saved : null};
        },
      };
      return query;
    }};
  }
  function load(route: string) {
    const exports: Record<string, (request: Request, context: {params: Promise<{id: string}>}) => Promise<Response>> = {};
    const compiled = ts.transpileModule(readFileSync(route,"utf8"), {
      compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
    }).outputText;
    const modules: Record<string,unknown> = {
      "node:crypto": { randomUUID },
      "@/lib/auth": {getAccount: async () => ({account:{role,tenantId:tenant}})},
      "@/lib/browser-tablets": {browserTablet: async () => enrolled ? {device:{id:device},kiosk:{id:kiosk,tenant_id:tenant}} : null},
      "@/lib/http": {
        json: (body: object,status=200) => Response.json(body,{status}),
        sameOrigin: (request: Request) => request.headers.get("origin") === "https://test.invalid",
      },
      "@/lib/court-logo": courtLogo,
      "@/lib/recorder-server": {recorderDatabase:database},
      "@/lib/validation": validation,
    };
    runInNewContext(compiled,{exports,Response,require:(name: string) => modules[name]});
    return exports;
  }
  const admin = load("app/api/admin/courts/[id]/recording-logo/route.ts");
  const recorder = load("app/api/tablet/recording-logo/[id]/route.ts");
  const ctx = (id: string) => ({params:Promise.resolve({id})});
  const upload = async (id=court, origin="https://test.invalid", bytes?: Buffer) =>
    admin.POST(new Request("https://test.invalid",{method:"POST",headers:{origin},body:new Uint8Array(bytes ?? await image())}),ctx(id));
  const get = new Request("https://test.invalid");
  role = "player";
  assert.equal((await upload()).status,403);
  role = "admin";
  assert.equal((await upload(court,"https://foreign.invalid")).status,403);
  assert.equal((await upload(randomUUID())).status,404);
  assert.equal((await admin.GET(get,ctx(court))).status,204);
  assert.equal((await recorder.GET(get,ctx(session))).status,204);
  assert.equal((await upload()).status,200);
  reserved = saved?.version;
  assert.ok(reserved);
  assert.equal((await upload(court,"https://test.invalid",Buffer.from("invalid"))).status,400);
  assert.equal(saved?.version,reserved);
  assert.equal((await admin.GET(get,ctx(court))).headers.get("content-type"),"image/png");
  assert.equal((await recorder.GET(get,ctx(session))).status,200);
  assert.equal((await recorder.GET(get,ctx(randomUUID()))).status,404);
  enrolled = false;
  assert.equal((await recorder.GET(get,ctx(session))).status,401);
  enrolled = true;
  assert.equal((await upload()).status,200);
  assert.notEqual(saved?.version,reserved);
  assert.equal((await recorder.GET(get,ctx(session))).status,404);
  const remove = new Request("https://test.invalid",{method:"DELETE",headers:{origin:"https://test.invalid"}});
  assert.equal((await admin.DELETE(remove,ctx(court))).status,200);
  assert.equal((await admin.GET(get,ctx(court))).status,204);
});
