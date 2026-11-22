import "server-only";
import nodemailer from "nodemailer";

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

export async function sendSmtpMail(raw: Buffer | string) {
  const { config, transport } = smtpTransport();
  const envelope = raw instanceof Buffer ? raw : Buffer.from(raw);
  const info = await transport.sendMail({ envelope: { from: config.from }, raw: envelope });
  return info.messageId || "";
}
