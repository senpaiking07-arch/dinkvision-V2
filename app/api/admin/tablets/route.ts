import { randomBytes } from "node:crypto";
import { getAccount } from "@/lib/auth";
import { recorderDatabase } from "@/lib/recorder-server";
import { hashKiosk } from "@/lib/kiosk";
import { json, readBody, sameOrigin } from "@/lib/http";
import { uuid, InputError } from "@/lib/validation";
import { publicTablet } from "@/lib/browser-tablets";
import QRCode from "qrcode";
import { qrEnrollmentPath } from "@/lib/tablet-enrollment";
import { qrColumns, readRecorderQueue, withOptionalColumns } from "@/lib/optional-schema";
export async function GET() {
  if ((await getAccount()).account?.role !== "admin")
    return json({ error: "Admin sign-in required." }, 403);
  const db = recorderDatabase();
  const queue = (captureDetails: boolean, retrySchedule: boolean) => db.from("browser_recordings").select(
    `session_id,device_id,job_id,file_id,safe_error,last_error,last_seen_at,upload_state,uploaded_bytes,bytes,upload_queued_at,upload_updated_at,branding_state,branding_progress,branding_updated_at,client_created_at,duration_ms,retry_count,local_available,device_copy_saved_at,device_copy_bytes,${retrySchedule ? "upload_retry_at," : ""}recording_sessions(id,court_id,status,recipient_email,created_at,started_at,stopped_at,duration_seconds,configuration_snapshot,failure_stage,${captureDetails ? "capture_interruption_code,capture_inspection_required," : ""}recording_files(id,status,drive_file_id,email_jobs(status,safe_error)))`,
  ).order("last_seen_at", { ascending: false }).limit(100);
  const [devices, courts, {result: recordings}, worker] = await Promise.all([
    db.from("browser_devices").select("*").order("created_at"),
    db.from("courts").select("id,name,active").order("created_at"),
    readRecorderQueue(queue, process.env.RECORDER_UPLOAD_BACKOFF_ENABLED === "true"),
    db
      .from("venue_settings")
      .select("browser_worker_at,venue_time_zone")
      .eq("id", true)
      .single(),
  ]);
  if (devices.error || courts.error || recordings.error)
    return json(
      { error: "Tablet setup needs the latest database migration." },
      503,
    );
  return json({
    serverTime:new Date().toISOString(),
    devices: devices.data.map(publicTablet),
    courts: courts.data,
    recordings: recordings.data,
    workerAt: worker.data?.browser_worker_at,
    timeZone: worker.data?.venue_time_zone || "Asia/Manila",
  });
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Invalid origin." }, 403);
  const { account } = await getAccount();
  if (account?.role !== "admin")
    return json({ error: "Admin sign-in required." }, 403);
  try {
    const b = await readBody(request),
      db = recorderDatabase();
    const id = b.id ? uuid(b.id) : null;
    if (b.action === "cancel-upload" && id) {
      const sessionId = uuid(b.session_id);
      const cancelled = await db.rpc("cancel_browser_upload", {
        p_session: sessionId,
        p_device: id,
      });
      if (cancelled.error) throw cancelled.error;
      if (!cancelled.data)
        return json(
          { error: "This upload is no longer waiting or uploading." },
          409,
        );
      const audit = await db.from("audit_events").insert({
        actor_id: account.id,
        session_id: sessionId,
        action: "tablet.upload_cancelled",
        safe_detail: { device_id: id },
      });
      if (audit.error) throw audit.error;
      return json({ ok: true, cancelled: true });
    }
    if (b.action === "retry-upload" && id) {
      const sessionId = uuid(b.session_id);
      const retried = await db.rpc("retry_browser_upload", {
        p_session: sessionId,
        p_device: id,
      });
      if (retried.error) throw retried.error;
      if (!retried.data)
        return json(
          { error: "This saved upload is no longer available to continue." },
          409,
        );
      const audit = await db.from("audit_events").insert({
        actor_id: account.id,
        session_id: sessionId,
        action: "tablet.upload_retry_requested",
        safe_detail: { device_id: id },
      });
      if (audit.error) throw audit.error;
      return json({ ok: true, retryRequested: true });
    }
    if (b.action === "remove" && id) {
      if (b.confirm !== true)
        throw new InputError("Confirm permanent device deletion.");
      const removed = await db.rpc("remove_browser_device", {
        p_device: id,
        p_actor: account.id,
      });
      if (removed.error) throw removed.error;
      if (!removed.data) return json({ error: "Device no longer exists." }, 404);
      return json({ ok: true, removed: true });
    }
    if (id) {
      const pending = await db
        .from("browser_recordings")
        .select("session_id,recording_sessions!inner(status)")
        .eq("device_id", id)
        .in("recording_sessions.status", [
          "requested",
          "starting",
          "recording",
          "finalizing",
        ])
        .limit(1);
      if (pending.error) throw pending.error;
      if (pending.data?.length)
        return json(
          {
            error:
              "Finish the active recording before changing this device.",
          },
          409,
        );
    }
    if (b.action === "test" && id) {
      const r = await db
        .from("browser_devices")
        .update({ test_requested: true, tested_at: null })
        .eq("id", id);
      if (r.error) throw r.error;
      return json({ ok: true });
    }
    if (b.action === "disable" && id) {
      const disable = (clearQr: boolean) => db.from("browser_devices").update({
          enabled: false,
          enrollment_hash: null,
          ...(clearQr ? { enrollment_qr_hash: null, enrollment_qr_failures: 0 } : {}),
          setup_hash: null,
          tested_at: null,
        })
        .eq("id", id)
        .select("kiosk_id")
        .single();
      const r = await withOptionalColumns(() => disable(true), () => disable(false), qrColumns);
      if (r.error) throw r.error;
      if (r.data.kiosk_id)
        await db
          .from("kiosk_devices")
          .update({ active: false })
          .eq("id", r.data.kiosk_id);
      return json({ ok: true });
    }
    if (b.action !== "save" && b.action !== "enroll")
      throw new InputError("Unknown action.");
    if (id && b.action === "enroll" && b.replace_enrollment !== true) {
      const previous=await db.from("browser_devices").select("kiosk_id").eq("id",id).single();
      if(previous.error) throw previous.error;
      if(previous.data.kiosk_id){
        const registration=await db.from("kiosk_devices").select("active").eq("id",previous.data.kiosk_id).single();
        if(registration.error) throw registration.error;
        if(registration.data.active) return json({replacementRequired:true,error:"This device is already registered. Confirm replacement before creating a new enrollment code."},409);
      }
    }
    const name = String(b.name || "").trim();
    if (!name || name.length > 100)
      throw new InputError("Enter a tablet name (up to 100 characters).");
    const court = b.court_id ? uuid(b.court_id) : null;
    const issue = b.action === "enroll" || !id;
    const code = issue ? randomBytes(9).toString("base64url") : "";
    const expiresAt = issue ? new Date(Date.now() + 600_000).toISOString() : null;
    const inviteLink = issue ? new URL(qrEnrollmentPath, request.headers.get("origin")!) : null;
    if (inviteLink) inviteLink.hash = `code=${code}`;
    const qr = inviteLink ? await QRCode.toDataURL(inviteLink.href, { width: 280, margin: 4, errorCorrectionLevel: "M" }) : null;
    const baseFields = {
      name,
      court_id: court,
      ...(issue ? { enrollment_hash: hashKiosk(code), enrollment_expires_at: expiresAt, enabled: true } : {}),
    };
    const write = (fields: Record<string, unknown>) => id
      ? db
          .from("browser_devices")
          .update(fields)
          .eq("id", id)
          .select("id")
          .single()
      : db.from("browser_devices").insert(fields).select("id").single();
    const r = issue ? await withOptionalColumns(
      () => write({ ...baseFields, enrollment_qr_hash: null, enrollment_qr_failures: 0 }),
      () => write(baseFields),
      qrColumns,
    ) : await write(baseFields);
    if (r.error) throw r.error;
    // The enrolling endpoint derives the administrator from this server-created record.
    if (b.action === "enroll" || !id) {
      const record = await db.from("audit_events").insert({
        actor_id: account.id,
        action: "tablet.enrollment_created",
        safe_detail: { device_id: r.data.id },
      });
      if (record.error) throw record.error;
    }
    return json({
      ok: true,
      id: r.data.id,
      ...(issue ? { qr, code, expiresAt } : {}),
    });
  } catch (e) {
    return json(
      {
        error:
          e instanceof InputError
            ? e.message
            : "Tablet setup could not be saved.",
      },
      400,
    );
  }
}
