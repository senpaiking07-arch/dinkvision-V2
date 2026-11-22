import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import nodemailer from "nodemailer";
import * as messages from "../lib/gmail";

function smtpModule(port: number) {
  const exports: any = {};
  runInNewContext(ts.transpileModule(readFileSync("lib/smtp.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    exports, Buffer, process: { env: { SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_SECURE: "false", SMTP_FROM: "DinkVision <sender@gmail.com>" } },
    require(name: string) {
      if (name === "server-only") return {};
      if (name === "nodemailer") return nodemailer;
      if (name === "./gmail") return messages;
      throw Error(name);
    },
  });
  return exports;
}

async function receiver(rejectRecipient?: string) {
  const sockets = new Set<Socket>();
  const deliveries: { from: string; recipients: string[]; mime: string }[] = [];
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let pending = "", data = false, from = "", recipients: string[] = [], lines: string[] = [];
    socket.write("220 localhost test receiver\r\n");
    socket.on("data", chunk => {
      pending += chunk.toString();
      let end: number;
      while ((end = pending.indexOf("\r\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 2);
        if (data) {
          if (line !== ".") { lines.push(line.replace(/^\.\./, ".")); continue; }
          deliveries.push({ from, recipients, mime: lines.join("\r\n") });
          data = false; socket.write("250 queued locally\r\n");
        } else if (/^EHLO|^HELO/.test(line)) socket.write("250 localhost\r\n");
        else if (/^MAIL FROM:/.test(line)) { from = line; socket.write("250 ok\r\n"); }
        else if (/^RCPT TO:/.test(line)) {
          if (rejectRecipient && line.includes(rejectRecipient)) socket.write("550 rejected by test receiver\r\n");
          else { recipients.push(line); socket.write("250 ok\r\n"); }
        } else if (line === "DATA") { data = true; lines = []; socket.write("354 send data\r\n"); }
        else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { port: (server.address() as { port: number }).port, deliveries,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

const message = (sender: string, recipients: string[]) => messages.recordingMessage(sender, recipients,
  "12345678-1234-1234-1234-123456789abc", "", "2026-11-24T00:00:00Z", "Asia/Manila", true, undefined,
  "https://dinkvision-v2.vercel.app/replay/test-token");

test("SMTP delivers a complete replay message to all recipients without exposing team addresses", { timeout: 10000 }, async () => {
  const local = await receiver();
  try {
    const smtp = smtpModule(local.port);
    const recipients = ["one@gmail.com", "two@gmail.com", "three@gmail.com", "four@gmail.com"];
    assert.ok(await smtp.sendSmtpMail(message("sender@gmail.com", recipients)));
    assert.equal(local.deliveries.length, 1);
    const delivery = local.deliveries[0];
    assert.match(delivery.from, /<sender@gmail.com>/);
    assert.equal(delivery.recipients.length, 4);
    for (const recipient of recipients) assert.ok(delivery.recipients.some(line => line.includes(`<${recipient}>`)));
    assert.match(delivery.mime, /^From: DinkVision <sender@gmail.com>/m);
    assert.match(delivery.mime, /Content-Type: multipart\/alternative/);
    assert.match(delivery.mime, /Content-Type: text\/plain/);
    assert.match(delivery.mime, /Content-Type: text\/html/);
    assert.doesNotMatch(delivery.mime, /^(?:Bcc|Cc):/mi);
    for (const recipient of recipients) assert.ok(!delivery.mime.includes(recipient));
  } finally { await local.close(); }
});

test("SMTP accepts a configured display name and keeps it in the delivered From header", { timeout: 10000 }, async () => {
  const local = await receiver();
  try {
    const smtp = smtpModule(local.port);
    await smtp.sendSmtpMail(message(smtp.smtpConfig().from, ["one@gmail.com"]));
    assert.match(local.deliveries[0].mime, /^From: DinkVision <sender@gmail.com>/m);
    assert.match(local.deliveries[0].mime, /^To: one@gmail.com/m);
  } finally { await local.close(); }
});

test("partial SMTP acceptance is not reported as delivered to the whole team", { timeout: 10000 }, async () => {
  const local = await receiver("two@gmail.com");
  try {
    await assert.rejects(() => smtpModule(local.port).sendSmtpMail(message("sender@gmail.com", ["one@gmail.com", "two@gmail.com"])),
      (error: any) => error.code === "partial_email_delivery" && error.outcome === "unknown");
  } finally { await local.close(); }
});
