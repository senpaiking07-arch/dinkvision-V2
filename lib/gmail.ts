import addressparser from "nodemailer/lib/addressparser";
import type { SendMailOptions } from "nodemailer";
import { captureInterruptionNotice } from "./capture-interruption";
import { replayEmailHtml } from "./replay-email-template";

export class MailError extends Error {
  constructor(public code: string, public outcome: "retry" | "failed" | "unknown", public retryAfter = 60000) { super(code); }
}

function email(value: string) {
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value) || /@example\.(com|net|org)$/i.test(value))
    throw new MailError("invalid_email_recipient", "failed");
  return value;
}

export function recordingSender(value: string) {
  if (/[\r\n]/.test(value)) throw new MailError("invalid_email_sender", "failed");
  const parsed = addressparser(value);
  if (parsed.length !== 1 || !("address" in parsed[0])) throw new MailError("invalid_email_sender", "failed");
  return { name: parsed[0].name || "DinkVision", address: email(parsed[0].address) };
}

export type RecordingEmail = SendMailOptions & { envelope: { from: string; to: string[] }; text: string; html: string };

// The worker now hands structured fields to SMTP instead of a Gmail API payload.
export function recordingMessage(sender: string, recipient: string | string[], file: string, _drive: string,
  expires: string, zone: string, linkAccess = false,
  interruption?: { code: unknown; durationMs: unknown }, privateReplayUrl?: string): RecordingEmail {
  const from = recordingSender(sender);
  const recipients = (Array.isArray(recipient) ? recipient : [recipient]).map(value => email(value.trim().toLowerCase()));
  if (!recipients.length || new Set(recipients).size !== recipients.length || recipients.length > 4)
    throw new MailError("invalid_email_recipient", "failed");
  if (!/^[a-f0-9-]{36}$/.test(file)) throw new MailError("invalid_recording", "failed");
  let replay: URL;
  try { replay = new URL(privateReplayUrl || ""); } catch { throw new MailError("invalid_replay_link", "failed"); }
  if (!["https:", "http:"].includes(replay.protocol) || replay.username || replay.password || !/^\/replay(?:\/|$)/.test(replay.pathname))
    throw new MailError("invalid_replay_link", "failed");
  const deadline = new Intl.DateTimeFormat("en-PH", { timeZone: zone, dateStyle: "medium", timeStyle: "short" }).format(new Date(expires));
  const accessNote = "Anyone with this link can watch. Share it only with people you want to see your recording.";
  const notice = captureInterruptionNotice(interruption?.code, interruption?.durationMs);
  const replayUrl = replay.href;
  const text = `Your game. On replay.\n\nYour DinkVision recording is ready.\n\n${notice ? `${notice}\n\n` : ""}Watch your recording:\n${replayUrl}\n\nWatch or download your video from the replay page.\n${accessNote}\n\nAvailable until ${deadline} (${zone}). Save a copy before this deadline; the replay link expires then.\n\nYour court. Your moment.\nDinkVision\nPowered by WrenLabs`;
  const logoUrl = replay.protocol === "https:" ? new URL("/dink-vision-logo.png", replay.origin).href : undefined;
  return {
    from,
    ...(recipients.length === 1 ? { to: recipients[0] } : { bcc: recipients }),
    envelope: { from: from.address, to: recipients },
    subject: notice ? "Your DinkVision replay is ready - recording interrupted" : "Your DinkVision match recording is ready",
    messageId: `<dinkvision-${file}@${from.address.split("@")[1]}>`,
    text,
    html: replayEmailHtml({ replayUrl, deadline, zone, accessNote, notice, logoUrl }),
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}
