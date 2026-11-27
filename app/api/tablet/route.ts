import { codes } from "@/lib/recorder-events";
import { browserTablet, canSetup, publicTablet } from "@/lib/browser-tablets";
import { recorderDatabase } from "@/lib/recorder-server";
import { json, readBody, sameOrigin } from "@/lib/http";
import { uuid, InputError } from "@/lib/validation";
import { browserUploadQueue } from "@/lib/browser-upload";
import { after } from "next/server";
import { deviceInfoInput } from "@/lib/device-info";
import { deliverNextEmail } from "@/lib/email-server";
import {
  cameraTransform,
  validCameraTransform,
} from "@/lib/camera-transform";
import { normalizeRecipients } from "@/lib/team-recipients";
import { venueStateError } from "@/lib/venue-errors";
import { androidUpdateRequired } from "@/lib/android-release";
import { isCaptureInterruption } from "@/lib/capture-interruption";
import { captureColumns, readRecorderQueue, retryColumns, withOptionalColumns } from "@/lib/optional-schema";
import { usesR2 } from "@/lib/r2-server";
import { r2Upload } from "@/lib/r2-upload";
import { R2_UPLOAD_PROTOCOL } from "@/lib/r2-protocol";
export const maxDuration = 60;
function uploadBackoffEnabled() {
  return process.env.RECORDER_UPLOAD_BACKOFF_ENABLED === "true";
}
const activeCaptureStatuses = [
  "requested",
  "starting",
  "recording",
  "finalizing",
];
type EnrolledBrowserTablet = NonNullable<
  Awaited<ReturnType<typeof browserTablet>>
>;
export async function browserTabletState(
  t: EnrolledBrowserTablet,
  includeSetupAccess = false,
) {
  const db = recorderDatabase(t.kiosk.tenant_id);
    const deviceQueue = (details: boolean, retrySchedule: boolean) => db.from("browser_recordings")
      .select(`session_id,job_id,upload_state,upload_updated_at,uploaded_bytes,bytes,retry_count,last_error,branding_state,client_created_at,duration_ms,local_available,${retrySchedule ? "upload_retry_at," : ""}recording_sessions(court_id,status,created_at,recipient_email,configuration_snapshot${details ? ",capture_interruption_code,capture_interrupted_at,capture_inspection_required" : ""})`)
      .eq("device_id", t.device.id).order("client_created_at", { ascending: false }).limit(100);
    const [court, settings, session, {result: queue, retrySchedule}] = await Promise.all([
      db
        .from("courts")
        .select("id,name,active")
        .eq("id", t.device.court_id || "00000000-0000-0000-0000-000000000000")
        .maybeSingle(),
      db
        .from("venue_settings")
        .select("max_duration_seconds")
        .eq("id", true)
        .single(),
      t.kiosk.current_session_id
        ? db
            .from("recording_sessions")
            .select(
              "id,court_id,status,started_at,duration_seconds,stop_requested_at,failure_stage,recording_files(id,email_jobs(status))",
            )
            .eq("id", t.kiosk.current_session_id)
            .eq("kiosk_id", t.kiosk.id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      readRecorderQueue(deviceQueue, uploadBackoffEnabled()),
    ]);
    if (court.error || settings.error || session.error || queue.error)
      throw court.error || settings.error || session.error || queue.error;
    const s = session.data as any;
    const mail = s?.recording_files?.[0]?.email_jobs;
    const uploadQueue =
      s && ["uploading", "sharing"].includes(s.status)
        ? await browserUploadQueue(s.id, t.device.id, false, t.kiosk.tenant_id)
        : null;
    return json({
      enabled: true,
      capabilities: {enrollmentRecovery:true,deviceCopyReporting: true,brandingProgressReporting:true,localFileSizeReporting:true,queuePresenceReporting:true,
        uploadProtocol: R2_UPLOAD_PROTOCOL,
        uploadBackoffScheduling:retrySchedule,
        recorderDiagnostics:process.env.RECORDER_DIAGNOSTICS_ENABLED==="true"},
      browser: true,
      device: publicTablet(t.device),
      canSetup: includeSetupAccess ? await canSetup(t.device) : false,
      maxSeconds: settings.data.max_duration_seconds,
      courts: court.data
        ? [
            {
              ...court.data,
              camera_status:
                court.data.active && t.device.tested_at ? "online" : "offline",
              audio_enabled: !!t.device.audio_device,
            },
          ]
        : [],
      session: s
        ? {
            ...s,
            recording_files: undefined,
            email_status:
              (Array.isArray(mail) ? mail[0]?.status : mail?.status) ||
              "pending",
          }
        : null,
      uploadQueue,
      queue: (queue.data || []).map((row: any) => {
        const session = Array.isArray(row.recording_sessions) ? row.recording_sessions[0] : row.recording_sessions;
        return {...row, recording_sessions: session ? {court_id: session.court_id, status: session.status,
          created_at: session.created_at, recipient_emails: normalizeRecipients(session.configuration_snapshot?.recipient_emails, session.recipient_email) || [],
          capture_interruption_code: session.capture_interruption_code,
          capture_interrupted_at: session.capture_interrupted_at,
          capture_inspection_required: session.capture_inspection_required} : null};
      }),
    });
}
export async function GET(request: Request) {
  try {
    const t = await browserTablet();
    if (!t) return json(request.headers.get("x-dinkvision-client") === "android"
      ? { enabled: false, capabilities: { enrollmentRecovery: true } }
      : { enabled: false });
    return await browserTabletState(
      t,
      new URL(request.url).searchParams.get("setup") === "1",
    );
  } catch (error) {
    console.error("Tablet state unavailable", { code: (error as {code?: string})?.code || "unexpected" });
    return json({ error: venueStateError(error, "Tablet connection unavailable. Please retry.") }, 503);
  }
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Invalid origin." }, 403);
  try {
    const t = await browserTablet();
    if (!t) return json({ error: "Enroll this browser first." }, 401);
    const b = await readBody(request),
      db = recorderDatabase(t.kiosk.tenant_id);
    if (b.action === "start") {
      const update = androidUpdateRequired(request, t.device.recorder_mode === "android_camera");
      if (update) return json(update, 426);
    }
    const deviceInfo = b.device_info === undefined ? undefined : deviceInfoInput(b.device_info);
    {
      // Every authenticated action proves device contact, including queue/branding
      // reports and retries. Activity must not appear offline while a heartbeat waits.
      const report = await db.from("browser_devices").update({ ...(deviceInfo ? {device_info: deviceInfo} : {}), last_seen_at: new Date().toISOString() })
        .eq("id", t.device.id).eq("tenant_id", t.kiosk.tenant_id);
      // Older databases still accept capture heartbeats while the additive migration is pending.
      if (report.error) {
        if (deviceInfo && ["42703", "PGRST204"].includes(report.error.code)) {
          const fallback=await db.from("browser_devices").update({last_seen_at:new Date().toISOString()}).eq("id",t.device.id).eq("tenant_id",t.kiosk.tenant_id);
          if (fallback.error) throw fallback.error;
        } else throw report.error;
      }
    }
    if (b.action === "heartbeat") {
      if (t.kiosk.current_session_id) {
        const current = await db
          .from("recording_sessions")
          .select("status")
          .eq("id", t.kiosk.current_session_id)
          .eq("kiosk_id", t.kiosk.id)
          .maybeSingle();
        if (current.error) throw current.error;
        if (current.data && activeCaptureStatuses.includes(current.data.status))
          await db.rpc("browser_event", {
            p_kiosk: t.kiosk.id,
            p_session: t.kiosk.current_session_id,
            p_action: "heartbeat",
          });
        else {
          const released = await db
            .from("kiosk_devices")
            .update({ current_session_id: null })
            .eq("id", t.kiosk.id)
            .eq("current_session_id", t.kiosk.current_session_id);
          if (released.error) throw released.error;
        }
      }
      return json({ ok: true });
    }
    if (b.action === "configure" || b.action === "tested") {
      if (t.device.recorder_mode === "android_rtsp")
        return json(
          { error: "Camera settings are managed in Device setup in the Android recorder." },
          403,
        );
      if (!(await canSetup(t.device)))
        return json(
          {
            error:
              "Admin setup permission expired. Sign in as admin on this tablet.",
          },
          403,
        );
      const current = t.kiosk.current_session_id
        ? await db
            .from("recording_sessions")
            .select("status")
            .eq("id", t.kiosk.current_session_id)
            .single()
        : null;
      if (
        current?.data &&
        activeCaptureStatuses.includes(current.data.status)
      )
        return json(
          { error: "Finish the recording before changing camera settings." },
          409,
        );
      if (b.action === "tested") {
        const r = await db
          .from("browser_devices")
          .update({
            tested_at: b.passed ? new Date().toISOString() : null,
            diagnostic: b.passed
              ? "Video/audio recording test passed."
              : "Camera test failed. Check permissions and connection.",
            test_requested: false,
          })
          .eq("id", t.device.id);
        if (r.error) throw r.error;
      } else {
        const source = String(b.source_type),
          video = String(b.video_device || ""),
          audio = String(b.audio_device || "");
        if (
          source !== "local" ||
          video.length > 512 ||
          audio.length > 512 ||
          !validCameraTransform(b)
        )
          throw new InputError("Invalid camera configuration.");
        if (!video)
          throw new InputError("Choose a camera detected by this browser.");
        const transform = cameraTransform(b);
        const r = await db
          .from("browser_devices")
          .update({
            source_type: "local",
            video_device: video,
            audio_device: audio,
            stream_url: "",
            camera_name: String(b.camera_name || "Camera").slice(0, 100),
            ...transform,
            tested_at: null,
          })
          .eq("id", t.device.id);
        if (r.error)
          throw new Error(
            r.error.code === "42703" || r.error.code === "PGRST204"
              ? "Camera setup is waiting for the latest database migration. Ask the administrator to update it."
              : "Camera settings could not be saved. Please retry.",
          );
      }
      return json({ ok: true });
    }
    if (b.action === "start") {
      const key = uuid(b.key),
        emails = normalizeRecipients(b.emails, b.email);
      if (!emails)
        throw new InputError(
          "Enter at least one valid email address on either team.",
        );
      const r = await db.rpc("browser_start", {
        p_kiosk: t.kiosk.id,
        p_email: emails[0],
        p_key: key,
        p_revision: b.revision ? uuid(b.revision) : null,
        p_recipients: emails,
      });
      if (r.error)
        return json(
          {
            error:
              r.error.code === "P0001"
                ? r.error.message
                : "This court is unavailable.",
          },
          409,
        );
      return json({ id: r.data });
    }
    const id = uuid(b.id);
    const deliveryAction = ["saved", "upload", "finish", "restart-upload", "retry-upload"].includes(String(b.action));
    const captureReport =
      (["captured", "saved", "failed"].includes(String(b.action)) ||
        (b.action === "upload-failed" && b.validation_failed === true)) &&
      (b.capture_interruption_code !== undefined || b.capture_interrupted_at !== undefined);
    let captureSchemaReady = true;
    const ownedRecording = (details: boolean) => {
      const table = db.from("browser_recordings");
      const fields = details ? table.select("session_id,upload_state,recording_sessions(capture_inspection_required)")
        : table.select("session_id,upload_state");
      return fields.eq("session_id", id).eq("device_id", t.device.id).maybeSingle();
    };
    const owned = deliveryAction || captureReport ? await withOptionalColumns(
      () => ownedRecording(true), () => { captureSchemaReady = false; return ownedRecording(false); }, captureColumns,
    ) : await ownedRecording(false);
    if (owned.error || !owned.data)
      return json(
        { error: "This recording does not belong to this tablet." },
        403,
      );
    const recording = "recording_sessions" in owned.data
      ? owned.data.recording_sessions as unknown as { capture_inspection_required?: boolean } | null
      : null;
    if (recording?.capture_inspection_required && deliveryAction)
      return json({ error: "This interrupted video needs inspection. Save the original on the tablet." }, 409);
    if (!captureSchemaReady && captureReport && b.action === "saved")
      return json({ error: "The interrupted video is saved on this tablet. Apply the database update before retrying its upload." }, 503);
    if (captureSchemaReady && captureReport) {
      if (!isCaptureInterruption(b.capture_interruption_code))
        throw new InputError("Invalid capture interruption reason.");
      const interruptedAt = b.capture_interrupted_at;
      if (interruptedAt != null &&
        (typeof interruptedAt !== "number" || !Number.isSafeInteger(interruptedAt) ||
          interruptedAt <= 0 || interruptedAt > Date.UTC(9999, 11, 31, 23, 59, 59, 999)))
        throw new InputError("Invalid capture interruption time.");
      if (b.action === "saved" &&
        (typeof b.duration_ms !== "number" || !Number.isSafeInteger(b.duration_ms) ||
          b.duration_ms < 1 || b.duration_ms > 7_200_000))
        throw new InputError("The recovered video needs a valid duration.");
      // Save the first report before the saved action can make the file eligible
      // for cloud delivery. Retries cannot replace the original capture cause.
      const interruption = await db.from("recording_sessions")
        .update({
          capture_interruption_code: b.capture_interruption_code,
          capture_interrupted_at: interruptedAt == null ? null : new Date(interruptedAt).toISOString(),
        })
        .eq("id", id).eq("kiosk_id", t.kiosk.id)
        .is("capture_interruption_code", null)
        .in("status", ["requested", "starting", "recording", "finalizing", "uploading", "failed"]);
      if (interruption.error) throw interruption.error;
      if (b.action === "failed" || b.action === "upload-failed") {
        const inspection = await db.from("recording_sessions")
          .update({ capture_inspection_required: true })
          .eq("id", id).eq("kiosk_id", t.kiosk.id)
          .in("status", ["requested", "starting", "recording", "finalizing", "uploading", "failed"]);
        if (inspection.error) throw inspection.error;
      }
    }
    if (b.action === "upload-turn") {
      if (!uploadBackoffEnabled()) return json({ error: "Upload scheduling is unavailable." }, 503);
      return json({ queue: await browserUploadQueue(id, t.device.id, false, t.kiosk.tenant_id) });
    }
    if (["saved", "retry-upload", "queue-report"].includes(String(b.action)) &&
        ["uploaded", "complete"].includes(owned.data.upload_state)) {
      const complete = await db.from("recording_sessions").select("id")
        .eq("id", id).eq("kiosk_id", t.kiosk.id).eq("status", "ready").maybeSingle();
      if (complete.error) throw complete.error;
      if (complete.data) {
        if (b.action === "queue-report" && b.status === "uploaded") {
          const copy = await db.from("browser_recordings").update({ local_available: b.local_available !== false })
            .eq("session_id", id).eq("device_id", t.device.id).in("upload_state", ["uploaded", "complete"]);
          if (copy.error) throw copy.error;
        }
        return json({ ok: true, ready: true, queued: false });
      }
    }
    if (b.action === "queue-presence") {
      // Presence is not a state transition: never reset confirmed upload bytes,
      // backoff, retry counts, leases, FIFO position or an administrator action.
      const presence = await db.from("browser_recordings")
        .update({last_seen_at: new Date().toISOString()})
        .eq("session_id", id).eq("device_id", t.device.id)
        .eq("local_available", true)
        .in("upload_state", ["saved_locally", "pending", "queued", "retrying"]);
      if (presence.error) throw presence.error;
      return json({ok: true});
    }
    if (b.action === "device-copy") {
      const bytes=Number(b.bytes);
      if (typeof b.bytes!=="number" || !Number.isSafeInteger(bytes) || bytes<1 || bytes>1_000_000_000_000) throw new InputError("Invalid saved-copy size.");
      const copy=await db.from("browser_recordings").update({device_copy_saved_at:new Date().toISOString(),device_copy_bytes:bytes})
        .eq("session_id",id).eq("device_id",t.device.id);
      if (copy.error) throw copy.error;
      return json({ok:true});
    }
    if (b.action === "queue-report") {
      const status = String(b.status || "");
      if (!["saved_locally", "pending", "uploading", "retrying", "uploaded", "failed", "local_only"].includes(status))
        throw new InputError("Invalid local queue status.");
      if (status === "uploaded")
        return json({ error: "Cloud upload completion has not been verified." }, 409);
      if(status==="local_only"&&owned.data.upload_state!=="local_only")
        throw new InputError("The local-only policy must be confirmed by the server first.");
      const progress = Number(b.progress || 0), retries = Number(b.retry_count || 0);
      if (!Number.isInteger(progress) || progress < 0 || progress > 100 || !Number.isInteger(retries) || retries < 0 || retries > 100)
        throw new InputError("Invalid local queue report.");
      if (status === "pending" && b.waiting_for_turn === true) {
        // The queue owns state, confirmed bytes, retry count and FIFO position.
        const waiting = await db.from("browser_recordings")
          .update({last_error: null, safe_error: null, last_seen_at: new Date().toISOString()})
          .eq("session_id", id).eq("device_id", t.device.id)
          .in("upload_state", ["pending", "queued"]);
        if (waiting.error) throw waiting.error;
        return json({ok: true});
      }
      const brandingState =
        b.branding_state === undefined
          ? undefined
          : b.branding_state === null || b.branding_state === ""
            ? null
            : String(b.branding_state);
      if (brandingState !== undefined && brandingState !== null &&
        !["processing", "complete", "failed"].includes(brandingState))
        throw new InputError("Invalid logo status.");
      const brandingProgress=b.branding_progress==null?undefined:Number(b.branding_progress);
      if(brandingProgress!==undefined&&(typeof b.branding_progress!=="number"||!Number.isInteger(brandingProgress)||brandingProgress<0||brandingProgress>100))
        throw new InputError("Invalid logo progress.");
      const reportedBytes=b.bytes==null?undefined:Number(b.bytes);
      if(reportedBytes!==undefined&&(typeof b.bytes!=="number"||!Number.isSafeInteger(reportedBytes)||reportedBytes<0||reportedBytes>32_000_000_000))
        throw new InputError("Invalid saved video size.");
      let update = db.from("browser_recordings").update({
        upload_state: status,
        uploaded_bytes: b.bytes ? Math.min(Number(b.bytes), Math.max(0, Number(b.uploaded_bytes || 0))) : 0,
        retry_count: retries,
        last_error: b.last_error ? String(b.last_error).slice(0, 300) : null,
        local_available: b.local_available !== false,
        client_created_at: b.created_at ? new Date(Number(b.created_at)).toISOString() : undefined,
        duration_ms: b.duration_ms == null ? undefined : Number(b.duration_ms),
        upload_updated_at: new Date().toISOString(),
        ...(brandingProgress===undefined?{}:{branding_progress:brandingProgress}),
        ...(reportedBytes&&reportedBytes>0?{bytes:reportedBytes}:{}),
        ...(brandingState === undefined
          ? {}
          : { branding_state: brandingState, branding_updated_at: new Date().toISOString() }),
      }).eq("session_id", id).eq("device_id", t.device.id);
      // Finalization reports this snapshot asynchronously. A transfer can
      // already own the recording by the time its earlier saved report arrives.
      if (status === "saved_locally" && brandingState === "complete")
        update = update.in("upload_state", ["idle", "saved_locally"]);
      const updated = await update;
      if (updated.error) throw updated.error;
      return json({ ok: true });
    }
    if (["upload","retry-upload","restart-upload","upload-status","upload-part","upload-parts","finish"].includes(String(b.action))) {
      if (!usesR2()) return json({error:"Private recording storage is not configured."},503);
      if (b.upload_protocol !== R2_UPLOAD_PROTOCOL)
        return json({error:"Update this recorder to the R2-compatible version. Saved videos are retained.",code:"upload_protocol_required"},426);
      if (b.action === "retry-upload") {
        const retry = await db.rpc("retry_browser_upload",{p_session:id,p_device:t.device.id});
        if (retry.error || !retry.data) return json({error:"This saved upload could not be retried."},409);
      }
      const result = await r2Upload(id,t.device.id,t.kiosk.tenant_id,String(b.action),b);
      if (result.ready) after(async () => { await deliverNextEmail(undefined,undefined,t.kiosk.tenant_id); });
      return json(result);
    }
    if (b.action === "upload-failed") {
      if (["uploaded", "complete", "cancelled"].includes(owned.data.upload_state))
        return json({ ok: true, upload_state: owned.data.upload_state });
      const retries = Number(b.retry_count || 0);
      if (!Number.isInteger(retries) || retries < 0 || retries > 100)
        throw new InputError("Invalid upload retry count.");
      const code = b.failure_code;
      if (code !== undefined && (typeof code !== "string" || !Object.hasOwn(codes, code) || code === "none"))
        throw new InputError("Invalid upload failure code.");
      const storage = /^(Cloud storage|Secure connection to cloud storage|Private storage upload)/.test(String(b.last_error || ""));
      const target = storage ? "Cloud storage" : "App server";
      const causes: Partial<Record<keyof typeof codes, string>> = {
        timeout: target + " request timed out.",
        dns: target + " address could not be resolved. Check the venue network.",
        tls: "Secure connection to " + target.toLowerCase() + " failed. Check the device date and time.",
        connection: target + " connection was interrupted.",
        http_server: target + " was temporarily unavailable.",
        http_client: target + " rejected the upload request.",
        validation: "Saved video validation failed. Check the saved video on the recorder.",
        device_or_storage: "The recorder could not access or process the saved video.",
        unknown: "The recorder could not identify the upload failure.",
      };
      const cause = code === undefined ? undefined : causes[code as keyof typeof codes];
      const retrying = b.retrying === true && b.validation_failed !== true;
      let scheduled = uploadBackoffEnabled();
      const delay = b.retry_delay_ms ?? 0;
      if (scheduled && (typeof delay !== "number" || !Number.isSafeInteger(delay) || delay < 0 || delay > 900_000))
        throw new InputError("Invalid upload retry delay.");
      if (b.validation_failed === true) {
        // Reuse the guarded capture transition to release a pre-upload session.
        // It cannot downgrade an uploading or completed recording on a late report.
        const validation = await db.rpc("browser_event", {
          p_kiosk: t.kiosk.id,
          p_session: id,
          p_action: "failed",
        });
        if (validation.error) throw validation.error;
      }
      const failed = await db.rpc("report_browser_upload", {
        p_session: id,
        p_device: t.device.id,
        p_state: "failed",
        p_uploaded_bytes: 0,
      });
      if (failed.error || !failed.data)
        return json({ error: "Upload queue state changed. Refresh and retry." }, 409);
      const updateFailure = (retrySchedule: boolean) => db.from("browser_recordings").update({
        ...(retrying ? { upload_state: "retrying" } : {}),
        ...(retrySchedule ? { upload_retry_at: retrying && Number(delay) > 0
          ? new Date(Date.now() + Number(delay)).toISOString() : null } : {}),
        ...(b.branding_state === undefined
          ? {}
          : {
              branding_state: ["processing", "complete", "failed"].includes(
                String(b.branding_state),
              )
                ? String(b.branding_state)
                : null,
              branding_updated_at: new Date().toISOString(),
            }),
        retry_count: retries,
        ...(b.local_available === undefined ? {} : {local_available: b.local_available !== false}),
        last_error: b.last_error
          ? String(b.last_error).slice(0, 300)
          : "Upload paused on this device.",
        safe_error: b.validation_failed === true
          ? "Video validation failed. Check the saved video on the original device."
          : b.branding_state === "failed"
          ? "Logo processing failed. The original video remains on the device."
          : cause ? cause + (retrying ? " Automatic retry scheduled." : " Check the recorder.")
          : b.retrying === true
          ? "Connection interrupted. Automatic retry scheduled."
          : "Upload paused on this device.",
      }).eq("session_id", id).eq("device_id", t.device.id).eq("upload_state", "failed");
      const updated = await withOptionalColumns(() => updateFailure(scheduled), () => {
        scheduled = false;
        return updateFailure(false);
      }, retryColumns);
      if (updated.error) throw updated.error;
      const acknowledged = await db.from("browser_recordings")
        .select(scheduled ? "upload_state,upload_updated_at,upload_retry_at" : "upload_state,upload_updated_at")
        .eq("session_id", id).eq("device_id", t.device.id).single();
      if (acknowledged.error) throw acknowledged.error;
      const state = acknowledged.data as unknown as {
        upload_state: string;
        upload_updated_at: string;
        upload_retry_at?: string | null;
      };
      return json({
        ok: true,
        upload_state: state.upload_state,
        upload_updated_at: state.upload_updated_at,
        ...(scheduled ? { upload_retry_at: state.upload_retry_at ?? null } : {}),
      });
    }
    if (
      !["started", "stopped", "captured", "saved", "failed", "reset"].includes(
        String(b.action),
      )
    )
      throw new InputError("Unknown action.");
    const durationMs = b.action === "saved" && b.duration_ms != null
      ? Number(b.duration_ms)
      : null;
    if (durationMs !== null &&
      (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 7200000))
      throw new InputError("Invalid recording duration.");
    const r = await db.rpc("browser_event", {
      p_kiosk: t.kiosk.id,
      p_session: id,
      p_action: b.action,
      p_bytes: b.bytes ?? null,
      p_mime: b.mime ?? null,
    });
    if (r.error) throw r.error;
    if (b.action === "saved" && b.branding_state !== undefined) {
      const brandingState = String(b.branding_state);
      if (!["processing", "complete", "failed"].includes(brandingState))
        throw new InputError("Invalid logo status.");
      const branded = await db
        .from("browser_recordings")
        .update({
          branding_state: brandingState,
          ...(brandingState==="complete"?{branding_progress:100}:{}),
          branding_updated_at: new Date().toISOString(),
        })
        .eq("session_id", id)
        .eq("device_id", t.device.id);
      if (branded.error) throw branded.error;
    }
    if (b.action === "saved") {
      const localOnly = await db.rpc("hold_short_browser_recording", {
        p_session: id,
        p_device: t.device.id,
        p_duration_ms: durationMs,
      });
      if (localOnly.error) throw localOnly.error;
      if (localOnly.data)
        return json({
          ok: true,
          localOnly: true,
          reason: "under_one_minute",
        });
      const unsupported = await db.rpc("hold_unsupported_browser_recording", {
        p_session: id,
        p_device: t.device.id,
      });
      if (unsupported.error) throw unsupported.error;
      if (unsupported.data)
        return json({
          ok: true,
          localOnly: true,
          reason: "unsupported_format",
        });
      const queued = await db.rpc("queue_browser_upload", {
        p_session: id,
        p_device: t.device.id,
      });
      if (queued.error || !queued.data)
        throw new Error("Could not add this saved video to the upload queue.");
    }
    if (!r.data) {
      const current = await db
        .from("recording_sessions")
        .select("status")
        .eq("id", id)
        .eq("kiosk_id", t.kiosk.id)
        .maybeSingle();
      if (current.error) throw current.error;
      const currentStatus = current.data?.status;
      let alreadyApplied =
        (b.action === "failed" && currentStatus === "failed") ||
        (b.action === "stopped" &&
          ["finalizing", "uploading", "sharing", "ready"].includes(
            currentStatus || "",
          )) ||
        (b.action === "captured" &&
          ["uploading", "sharing", "ready"].includes(currentStatus || "")) ||
        (b.action === "started" &&
          ["recording", "finalizing", "uploading", "sharing", "ready"].includes(
            currentStatus || "",
          ));
      if (
        b.action === "saved" &&
        ["uploading", "sharing", "ready"].includes(currentStatus || "")
      ) {
        const recording = await db
          .from("browser_recordings")
          .select("file_id,bytes,mime_type")
          .eq("session_id", id)
          .maybeSingle();
        if (recording.error) throw recording.error;
        alreadyApplied =
          !!recording.data?.file_id &&
          Number(recording.data.bytes) === Number(b.bytes) &&
          recording.data.mime_type === b.mime;
      }
      if (alreadyApplied) return json({ ok: true });
      return json(
        {
          error: "Recording status changed. The tablet is syncing now.",
          code: "recording_state_changed",
        },
        409,
      );
    }
    return json({ ok: true });
  } catch (e) {
    return json(
      {
        error:
          e instanceof InputError
            ? e.message
            : e instanceof Error && !("code" in e)
              ? e.message
              : "Recording request failed. Please retry.",
      },
      e instanceof InputError ? 400 : 503,
    );
  }
}
