import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as messages from "../lib/gmail";
import * as optionalSchema from "../lib/optional-schema";

async function deliver(options: { expired?: boolean; leaseLost?: boolean; partial?: boolean } = {}) {
  const updates: any[] = [], sent: messages.RecordingEmail[] = [];
  let audited = false;
  const expires = new Date(Date.now() + (options.expired ? -60000 : 3600000)).toISOString();
  const file = { id: "12345678-1234-1234-1234-123456789abc", tenant_id: "tenant", session_id: "session",
    storage_provider: "r2", status: "ready", expires_at: expires, deleted_at: null,
    recording_sessions: { recipient_email: "one@gmail.com", configuration_snapshot: { recipient_emails: ["one@gmail.com", "two@gmail.com"] } } };
  const db = {
    rpc: async () => ({ data: [{ file_id: file.id, lease_token: "lease", attempts: 1 }], error: null }),
    from(table: string) {
      const query: any = { select: () => query, eq: () => query, gt: () => query,
        single: async () => ({ error: null, data: table === "recording_files" ? file : { venue_time_zone: "Asia/Manila" } }),
        maybeSingle: async () => ({ error: null, data: options.leaseLost ? null : { file_id: file.id } }),
        update(value: any) { assert.equal(table, "email_jobs"); updates.push(value); return query; },
        insert: async () => { audited = true; return { error: null }; },
        then: (resolve: any) => Promise.resolve({ error: null }).then(resolve),
      }; return query;
    },
  };
  const dependencies: Record<string, unknown> = {
    "server-only": {}, "./gmail": messages, "./optional-schema": optionalSchema,
    "./recorder-server": { recorderDatabase: (tenant: string) => { assert.equal(tenant, "tenant"); return db; } },
    "./replay-server": { replayLink: () => "https://dinkvision-v2.vercel.app/replay/fixture" },
    "./smtp": { smtpConfig: () => ({ from: "DinkVision <sender@gmail.com>" }), sendSmtpMail: async (message: messages.RecordingEmail) => {
      assert.equal(updates.length, 0, "The job cannot become sent before SMTP succeeds"); sent.push(message);
      if (options.partial) throw new messages.MailError("partial_email_delivery", "unknown");
      return "smtp-message-id";
    } },
  };
  const exports: any = {};
  runInNewContext(ts.transpileModule(readFileSync("lib/email-server.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; } });
  await exports.deliverNextEmail(undefined, file.id, "tenant");
  return { updates, sent, audited };
}

test("the recording worker hands SMTP a branded message and records success only after acceptance", async () => {
  const result = await deliver();
  assert.equal(result.sent.length, 1);
  assert.deepEqual(result.sent[0].envelope.to, ["one@gmail.com", "two@gmail.com"]);
  assert.equal(result.sent[0].envelope.from, "sender@gmail.com");
  assert.match(result.sent[0].html, /On replay\./);
  assert.doesNotMatch(result.sent[0].text, /Sign in to Google/);
  assert.equal(result.updates[0].status, "sent");
  assert.equal(result.updates[0].gmail_message_id, "smtp-message-id");
  assert.equal(result.audited, true);
});

test("partial acceptance requires review and is not automatically resent", async () => {
  const result = await deliver({ partial: true });
  assert.equal(result.updates[0].status, "unknown");
  assert.equal(result.updates[0].safe_error, "partial_email_delivery");
  assert.equal(result.audited, false);
});

test("expired recordings and lost leases do not send email", async () => {
  assert.equal((await deliver({ expired: true })).sent.length, 0);
  const lost = await deliver({ leaseLost: true });
  assert.equal(lost.sent.length, 0);
  assert.equal(lost.updates.length, 0);
});
