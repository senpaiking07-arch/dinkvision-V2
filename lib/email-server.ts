import "server-only";
import { MailError, recordingMessage } from "./gmail";
import { recorderDatabase } from "./recorder-server";
import { captureColumns, withOptionalColumns } from "./optional-schema";
import { replayLink } from "./replay-server";
import { smtpConfig, sendSmtpMail } from "./smtp";

export async function deliverNextEmail(recorderId?: string, fileId?: string, tenantId?: string) {
  const db = recorderDatabase(tenantId);
  const claimed = recorderId
    ? await db.rpc("claim_recording_email", { p_recorder: recorderId })
    : fileId
      ? await db.rpc("claim_browser_email_for_file", { p_file: fileId })
      : await db.rpc("claim_browser_email");
  if (claimed.error) throw claimed.error;
  const job = claimed.data?.[0];
  if (!job) return;
  let sending = false;
  try {
    const f = await withOptionalColumns(
      () => db.from("recording_files").select("id,tenant_id,storage_provider,session_id,status,expires_at,deleted_at,recording_sessions(recipient_email,configuration_snapshot,capture_interruption_code,browser_recordings(duration_ms))").eq("id", job.file_id).single(),
      () => db.from("recording_files").select("id,tenant_id,storage_provider,session_id,status,expires_at,deleted_at,recording_sessions(recipient_email,configuration_snapshot)").eq("id", job.file_id).single(),
      captureColumns,
    );
    if (f.error) throw f.error;
    const file = f.data;
    if (file.status !== "ready" || file.deleted_at || Date.parse(file.expires_at) <= Date.now()) throw new MailError("recording_expired", "failed");
    const settings = await db.from("venue_settings").select("venue_time_zone").eq("id", true).single();
    if (settings.error) throw settings.error;
    const smtp = smtpConfig();
    const session = file.recording_sessions as unknown as {
      recipient_email: string;
      configuration_snapshot?: { sharing_mode?: string; recipient_emails?: unknown };
      capture_interruption_code?: string | null;
      browser_recordings?: { duration_ms: number | null } | null;
    };
    const configured = session.configuration_snapshot?.recipient_emails;
    const recipients = Array.isArray(configured) && configured.every(value => typeof value === "string")
      ? configured as string[]
      : session.recipient_email;
    const raw = recordingMessage(
      smtp.from,
      recipients,
      file.id,
      "",
      file.expires_at,
      settings.data.venue_time_zone || "Asia/Manila",
      file.storage_provider === "r2" || session.configuration_snapshot?.sharing_mode === "link",
      { code: session.capture_interruption_code, durationMs: session.browser_recordings?.duration_ms },
      replayLink(file.tenant_id, file.id, file.expires_at),
    );
    const lease = await db.from("email_jobs").select("file_id").eq("file_id", job.file_id).eq("lease_token", job.lease_token).eq("status", "sending").gt("lease_until", new Date(Date.now() + 30000).toISOString()).maybeSingle();
    if (lease.error || !lease.data) return;
    if (Date.parse(file.expires_at) <= Date.now()) throw new MailError("recording_expired", "failed");
    sending = true;
    const id = await sendSmtpMail(raw);
    const saved = await db.from("email_jobs").update({ status: "sent", gmail_message_id: id, sent_at: new Date().toISOString(), lease_until: null, safe_error: null }).eq("file_id", job.file_id).eq("lease_token", job.lease_token).eq("status", "sending");
    if (saved.error) throw saved.error;
    await db.from("audit_events").insert({ session_id: file.session_id, action: "email.sent" });
  } catch (error) {
    const e = error instanceof MailError ? error : sending ? new MailError("send_outcome_unknown", "unknown") : new MailError("email_service_unavailable", "retry");
    const retry = e.outcome === "retry" && job.attempts < 8;
    await db.from("email_jobs").update({
      status: retry ? "pending" : e.outcome === "unknown" ? "unknown" : "failed",
      safe_error: e.code,
      lease_until: null,
      next_attempt_at: new Date(Date.now() + Math.max(e.retryAfter, Math.min(3600000, 15000 * 2 ** Math.min(job.attempts, 8)))).toISOString(),
    }).eq("file_id", job.file_id).eq("lease_token", job.lease_token).eq("status", "sending");
  }
}
