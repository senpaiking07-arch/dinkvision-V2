import "server-only";
import { randomUUID } from "node:crypto";
import { recorderDatabase } from "./recorder-server";
import { browserUploadQueue } from "./browser-upload";
import { r2Store } from "./r2-server";
import { missingUpload, type R2Object } from "./r2-store";
import {
  confirmedParts, R2_DEFAULT_PART_SIZE, R2_MAX_BYTES, R2_MAX_PARTS, R2_UPLOAD_PROTOCOL, normalizePartSize,
} from "./r2-protocol";

type Attempt = R2Object & { id: string; session_id: string; tenant_id: string; bytes: number; state: string; part_size?: number };
export class UploadRequestError extends Error {}

type Progress = { offset: number; uploaded: boolean; parts: { PartNumber: number; ETag: string }[]; partSize: number };

function assertHead(head: NonNullable<Awaited<ReturnType<ReturnType<typeof r2Store>["head"]>>>, attempt: Attempt) {
  if (head.ContentLength !== Number(attempt.bytes) || head.ContentType !== "video/mp4" || !head.ETag ||
    head.Metadata?.attempt !== attempt.id || head.Metadata?.session !== attempt.session_id || head.Metadata?.tenant !== attempt.tenant_id)
    throw new UploadRequestError("Stored video does not match this recording. The local backup is retained.");
}

function partSizeOf(attempt: Attempt) { return normalizePartSize(attempt.part_size); }
function grantFor(attempt: Attempt, bytes: number) {
  return { protocol: R2_UPLOAD_PROTOCOL, attemptId: attempt.id, partSize: partSizeOf(attempt), bytes, mime: "video/mp4" };
}
function expectedNextPart(uploadedBytes: number, partSize: number, bytes: number) {
  if (uploadedBytes >= bytes) return null;
  if (uploadedBytes < 0 || uploadedBytes % partSize !== 0) return null;
  return uploadedBytes / partSize + 1;
}

async function listProgress(store: ReturnType<typeof r2Store>, attempt: Attempt, bytes: number, head: any): Promise<Progress> {
  if (head) return { offset: bytes, uploaded: true, parts: [], partSize: partSizeOf(attempt) };
  return confirmedParts(await store.parts(attempt), bytes, partSizeOf(attempt));
}

async function reportProgress(db: any, session: string, device: string, bytes: number, previous: number) {
  if (bytes <= previous) return previous;
  const report = await db.rpc("report_browser_upload", { p_session: session, p_device: device, p_state: "uploading", p_uploaded_bytes: bytes });
  if (report.error || !report.data) throw new UploadRequestError("Upload was paused. Sync the saved video before retrying.");
  return bytes;
}

export async function r2Upload(session: string, device: string, tenant: string, action: string, input: Record<string, unknown> = {}) {
  const started = Date.now();
  const timings: Record<string, number> = {};
  const mark = async <T>(name: string, fn: () => Promise<T>) => { const t = Date.now(); try { return await fn(); } finally { timings[name] = (timings[name] || 0) + Date.now() - t; } };
  const db = recorderDatabase(tenant);
  const queue = await mark("queue", () => browserUploadQueue(session, device, true, tenant));
  if (["complete", "uploaded"].includes(queue.state)) return { ready: true, uploaded: true, queued: false, queue, timings };
  if (!queue.allowed) return { ready: false, queued: true, queue, timings };
  const lease = randomUUID();
  const locked = await mark("lock", async () => db.from("browser_recordings").update({ lease_token: lease, lease_until: new Date(Date.now() + 120000).toISOString() })
    .eq("session_id", session).eq("device_id", device).eq("upload_state", "uploading")
    .or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`)
    .select("file_id,bytes,mime_type,uploaded_bytes,recording_sessions(capture_inspection_required)").maybeSingle());
  if (locked.error || !locked.data) throw new UploadRequestError("Upload is busy. Retry shortly.");
  try {
    const b = locked.data as any;
    const recording = b.recording_sessions as unknown as { capture_inspection_required: boolean } | null;
    if (recording?.capture_inspection_required)
      throw new UploadRequestError("Inspect the interrupted recording before uploading. The local backup is retained.");
    const bytes = Number(b.bytes);
    if (!b.file_id || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > R2_MAX_BYTES || b.mime_type !== "video/mp4")
      throw new UploadRequestError("Save a valid MP4 recording before uploading.");
    const store = r2Store();
    const found = await mark("find_attempt", async () => db.from("r2_upload_attempts").select("*").eq("session_id", session)
      .in("state", ["creating", "uploading", "completed"]).order("created_at", { ascending: false }).limit(1).maybeSingle());
    if (found.error) throw found.error;
    let attempt = found.data as Attempt | null;
    let head = attempt ? await mark("head_initial", () => store.head(attempt!)) : null;
    if (attempt && head) assertHead(head, attempt);
    // Recover an ambiguous multipart completion before considering a restart.
    if (attempt && !head && (action === "restart-upload" || attempt.state === "creating")) {
      const retired = await db.from("r2_upload_attempts").update({ state: "aborting", updated_at: new Date().toISOString() }).eq("id", attempt.id);
      if (retired.error) throw retired.error;
      await mark("abort_ambiguous", () => store.abort(attempt!));
      const aborted = await db.from("r2_upload_attempts").update({ state: "aborted", updated_at: new Date().toISOString() }).eq("id", attempt.id);
      if (aborted.error) throw aborted.error;
      attempt = null; head = null;
    }
    if (!attempt) {
      if (["finish", "upload-status", "upload-part", "upload-parts"].includes(action)) return { expired: true, timings };
      const id = randomUUID();
      const requestedPartSize = normalizePartSize(input.part_size ?? R2_DEFAULT_PART_SIZE);
      const partSize = requestedPartSize * R2_MAX_PARTS >= bytes ? requestedPartSize : R2_DEFAULT_PART_SIZE;
      attempt = {
        id, session_id: session, tenant_id: tenant, bucket: store.bucket,
        object_key: `tenants/${tenant}/recordings/${session}/${id}.mp4`, upload_id: null, bytes, state: "creating", part_size: partSize,
      };
      const inserted = await db.from("r2_upload_attempts").insert({ ...attempt, device_id: device, mime_type: "video/mp4", part_size: partSize });
      if (inserted.error) throw inserted.error;
      attempt.upload_id = await mark("create_multipart", () => store.create(attempt!, { attempt: id, session, tenant }));
      const saved = await db.from("r2_upload_attempts").update({ upload_id: attempt.upload_id, state: "uploading", updated_at: new Date().toISOString() }).eq("id", id);
      if (saved.error) { await store.abort(attempt); throw saved.error; }
      attempt.state = "uploading";
      const reset = await db.from("browser_recordings").update({ uploaded_bytes: 0 })
        .eq("session_id", session).eq("lease_token", lease).eq("upload_state", "uploading");
      if (reset.error) throw reset.error;
    }
    if (Number(attempt.bytes) !== bytes) throw new UploadRequestError("Upload size changed. Retry the saved recording.");
    const partSize = partSizeOf(attempt);
    const grant = grantFor(attempt, bytes);
    if (["upload", "retry-upload", "restart-upload"].includes(action)) return { ready: false, queued: false, queue, upload: grant, timings };
    if (input.attempt_id !== attempt.id) throw new UploadRequestError("Upload attempt changed. Prepare the upload again.");

    const dbUploaded = Math.max(0, Number(b.uploaded_bytes || 0));
    const needsFullReconcile = action === "finish" || action === "upload-status" || action === "restart-upload" || input.reconcile === true;
    let progress: Progress | null = null;
    const ensureProgress = async () => {
      if (progress) return progress;
      try { progress = await mark("list_parts", () => listProgress(store, attempt!, bytes, head)); }
      catch (error) { if (missingUpload(error)) return null; throw error; }
      await mark("report_progress", () => reportProgress(db, session, device, progress!.offset, dbUploaded));
      const touched = await db.from("r2_upload_attempts").update({ updated_at: new Date().toISOString() }).eq("id", attempt!.id);
      if (touched.error) throw touched.error;
      return progress;
    };

    if (needsFullReconcile) {
      const p = await ensureProgress();
      if (!p) return { expired: true, timings };
      if (action === "upload-status") return { ...grant, offset: p.offset, uploaded: p.uploaded, timings };
    }

    if (action === "upload-part" || action === "upload-parts") {
      const numbersRaw = action === "upload-parts" ? input.part_numbers : [input.part_number];
      const numbers = Array.isArray(numbersRaw) ? numbersRaw.map((n) => Number(n)) : [];
      if (!numbers.length) throw new UploadRequestError("Missing upload part number.");
      if (numbers.length > 8) throw new UploadRequestError("Too many upload parts requested.");
      const seen = new Set<number>();
      for (const n of numbers) {
        if (!Number.isSafeInteger(n) || n < 1) throw new UploadRequestError("Invalid upload part number.");
        if (seen.has(n)) throw new UploadRequestError("Duplicate upload part number.");
        seen.add(n);
      }
      const totalParts = Math.ceil(bytes / partSize);
      if (numbers.some((n) => n > totalParts)) throw new UploadRequestError("Invalid upload part.");
      const expectedNext = expectedNextPart(dbUploaded, partSize, bytes);
      const canSkipList = !needsFullReconcile && expectedNext !== null && numbers.every((n) => n >= expectedNext && n <= expectedNext + 7);
      const p = canSkipList ? null : await ensureProgress();
      if (!canSkipList && !p) return { expired: true, timings };
      if (p?.uploaded) return { ...grant, uploaded: true, offset: bytes, parts: [], timings };
      const confirmedOffset = p ? p.offset : dbUploaded;
      const next = p ? p.parts.length + 1 : expectedNext!;
      if (!numbers.every((n) => n >= next && n <= next + 7)) {
        const reconciled = await ensureProgress();
        if (!reconciled) return { expired: true, timings };
        if (reconciled.uploaded) return { ...grant, uploaded: true, offset: bytes, parts: [], timings };
        const nextConfirmed = reconciled.parts.length + 1;
        if (!numbers.every((n) => n >= nextConfirmed && n <= nextConfirmed + 7))
          throw new UploadRequestError("Upload progress changed. Check the confirmed offset before sending the next part.");
        const entries = numbers.map((n) => ({ number: n, length: Math.min(partSize, bytes - (n - 1) * partSize) }));
        const urls = await mark("sign_parts", () => store.partUrls(attempt!, entries, 600));
        return { ...grant, offset: reconciled.offset, uploaded: false, parts: urls, partNumber: urls[0].partNumber, length: urls[0].length, url: urls[0].url, timings };
      }
      const entries = numbers.map((n) => ({ number: n, length: Math.min(partSize, bytes - (n - 1) * partSize) }));
      const urls = await mark("sign_parts", () => store.partUrls(attempt!, entries, 600));
      return { ...grant, offset: confirmedOffset, uploaded: false, parts: urls, partNumber: urls[0].partNumber, length: urls[0].length, url: urls[0].url, timings };
    }

    if (action !== "finish") throw new UploadRequestError("Unknown upload action.");
    const p = await ensureProgress();
    if (!p) return { expired: true, timings };
    if (!p.uploaded) throw new UploadRequestError("Upload is not complete. The local backup is retained.");
    const live = await db.from("browser_recordings").select("session_id").eq("session_id", session)
      .eq("lease_token", lease).eq("upload_state", "uploading").gt("lease_until", new Date(Date.now() + 30000).toISOString()).maybeSingle();
    if (live.error || !live.data) throw new UploadRequestError("Upload was paused before confirmation.");
    if (!head) {
      try { await mark("complete_multipart", () => store.complete(attempt!, p.parts)); }
      catch (error) {
        head = await mark("head_after_complete_error", () => store.head(attempt!));
        if (!head) throw error;
      }
      head = head || await mark("head_after_complete", () => store.head(attempt!));
    }
    if (!head) throw new UploadRequestError("Storage confirmation is pending. Retry the saved video.");
    assertHead(head, attempt);
    const finished = await mark("finish_rpc", async () => db.rpc("finish_r2_upload", { p_session: session, p_device: device, p_attempt: attempt!.id, p_lease: lease, p_etag: head!.ETag, p_bytes: bytes }));
    if (finished.error || !finished.data) throw new UploadRequestError("Upload confirmation is pending. Retry the saved video.");
    return { ready: true, uploaded: true, queued: false, queue: { ...queue, state: "uploaded", percent: 100 }, timings: { ...timings, total: Date.now() - started } };
  } catch (error) {
    if (error instanceof UploadRequestError) throw error;
    throw new UploadRequestError("Private storage is temporarily unavailable. Your local recording is retained; retry shortly.");
  } finally {
    await db.from("browser_recordings").update({ lease_until: null }).eq("session_id", session).eq("lease_token", lease);
  }
}
