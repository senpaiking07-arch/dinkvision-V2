import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

function load(path: string, dependencies: Record<string, unknown>) {
  const exports: any = {};
  const source = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(source, { exports, require(name: string) {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  return exports;
}

function renderStatus(data: unknown) {
  let stateIndex = 0;
  const component = load("components/storage-smtp-controls.tsx", {
    "react/jsx-runtime": jsx,
    react: { useEffect() {}, useState: (initial: unknown) => [stateIndex++ === 0 ? data : initial, () => {}] },
  });
  return renderToStaticMarkup(component.default());
}

function routes(configured: boolean, ready: boolean, account: unknown = { role: "admin", tenantId: "tenant" }) {
  const checkedAt = "2026-11-22T12:00:00.000Z";
  const storage = { ready: true, code: "connected", checkedAt };
  const from = "DinkVision <sender@example.com>";
  let probes = 0;
  const dependencies = {
    "@/lib/auth": { getAccount: async () => ({ account }) },
    "@/lib/http": { json: (body: unknown, status = 200) => Response.json(body, { status }) },
    "@/lib/storage-health": { storageHealth: async () => { probes++; return storage; } },
    "@/lib/smtp": {
      smtpConfig: () => {
        if (!configured) throw Error("Missing SMTP_HOST");
        return { from, host: "smtp.example.com", user: "private-user", pass: "private-password" };
      },
      smtpHealth: async () => {
        probes++;
        return { ready, code: ready ? "connected" : "smtp_unavailable", checkedAt, ...(!ready && { detail: "SMTP verification failed" }) };
      },
    },
  };
  return {
    get: load("app/api/integrations/storage/status/route.ts", dependencies).GET,
    post: load("app/api/integrations/storage/health/route.ts", dependencies).POST,
    probes: () => probes,
  };
}

test("connected status hides setup instructions and Check again preserves the same status contract", async () => {
  const api = routes(true, true);
  const initial = await (await api.get()).json();
  assert.match(renderStatus(initial), /R2 storage and SMTP email connected/);
  assert.doesNotMatch(renderStatus(initial), /Configure SMTP|SMTP_HOST/);
  const refreshed = await (await api.post()).json();
  assert.deepEqual(refreshed.storage, initial.storage);
  assert.deepEqual(refreshed.smtp, initial.smtp);
  assert.equal(refreshed.provider, "r2");
  assert.match(renderStatus(refreshed), /R2 storage and SMTP email connected/);
  assert.doesNotMatch(renderStatus(refreshed), /Configure SMTP|SMTP_HOST/);
  assert.doesNotMatch(JSON.stringify(refreshed), /private-user|private-password|smtp\.example\.com/);
});

test("both checks distinguish missing SMTP configuration from a failed connection", async () => {
  for (const configured of [false, true]) {
    const api = routes(configured, false);
    for (const check of [api.get, api.post]) {
      const data = await (await check()).json();
      assert.equal(data.smtp.configured, configured);
      const html = renderStatus(data);
      if (configured) {
        assert.match(html, /Configured but unavailable/);
        assert.doesNotMatch(html, /SMTP_HOST/);
      } else {
        assert.match(html, /Not configured/);
        assert.match(html, /SMTP_HOST/);
      }
    }
  }
});

test("both checks require a tenant admin before probing storage or SMTP", async () => {
  for (const account of [null, { role: "player", tenantId: "tenant" }, { role: "admin", tenantId: null }]) {
    const api = routes(true, true, account);
    assert.equal((await api.get()).status, 403);
    assert.equal((await api.post()).status, 403);
    assert.equal(api.probes(), 0);
  }
});
