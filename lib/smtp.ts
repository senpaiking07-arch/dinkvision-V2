import "server-only";
import nodemailer from "nodemailer";
import { MailError, recordingSender, type RecordingEmail } from "./gmail";

type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
};

let cached: { key: string; transport: nodemailer.Transporter } | undefined;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function smtpConfig(): SmtpConfig {
  const host = required("SMTP_HOST");
  const port = Number(process.env.SMTP_PORT || "465");
  const secure = (process.env.SMTP_SECURE || "true").toLowerCase() !== "false";
  const user = process.env.SMTP_USER?.trim() || undefined;
  const pass = process.env.SMTP_PASS || undefined;
  const from = process.env.SMTP_FROM?.trim() || user;
  if (!Number.isFinite(port) || port <= 0) throw new Error("Invalid SMTP_PORT");
  if (!from) throw new Error("Missing SMTP_FROM");
  recordingSender(from);
  if ((user && !pass) || (!user && pass)) throw new Error("SMTP_USER and SMTP_PASS must be set together");
  return { host, port, secure, user, pass, from };
}

export function smtpTransport() {
  const config = smtpConfig();
  const key = JSON.stringify(config);
  if (cached?.key !== key) {
    cached = {
      key,
      transport: nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user ? { user: config.user, pass: config.pass } : undefined,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
      }),
    };
  }
  return { config, transport: cached.transport };
}

export async function smtpHealth() {
  try {
    const { transport } = smtpTransport();
    await transport.verify();
    return { ready: true, code: "connected", checkedAt: new Date().toISOString() };
  } catch (error) {
    return {
      ready: false,
      code: "smtp_unavailable",
      checkedAt: new Date().toISOString(),
      detail: error instanceof Error ? error.message : "SMTP verification failed",
    };
  }
}

export async function sendSmtpMail(message: RecordingEmail) {
  const { transport } = smtpTransport();
  const info = await transport.sendMail(message);
  if (info.rejected?.length || info.accepted?.length !== message.envelope.to.length)
    throw new MailError("partial_email_delivery", "unknown");
  return info.messageId || "";
}
