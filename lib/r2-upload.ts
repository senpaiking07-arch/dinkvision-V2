import "server-only";
import { randomUUID } from "node:crypto";
import { recorderDatabase } from "./recorder-server";
import { browserUploadQueue } from "./browser-upload";
import { r2Store } from "./r2-server";
import { missingUpload, type R2Object } from "./r2-store";
import { confirmedParts, R2_PART_SIZE, R2_MAX_BYTES, R2_UPLOAD_PROTOCOL } from "./r2-protocol";

type Attempt = R2Object & {id:string;session_id:string;tenant_id:string;bytes:number;state:string};
export class UploadRequestError extends Error {}

function assertHead(head: NonNullable<Awaited<ReturnType<ReturnType<typeof r2Store>["head"]>>>, attempt: Attempt) {
  if (head.ContentLength !== Number(attempt.bytes) || head.ContentType !== "video/mp4" || !head.ETag ||
      head.Metadata?.attempt !== attempt.id || head.Metadata?.session !== attempt.session_id || head.Metadata?.tenant !== attempt.tenant_id)
    throw new UploadRequestError("Stored video does not match this recording. The local backup is retained.");
}

export async function r2Upload(session: string, device: string, tenant: string, action: string, input: Record<string,unknown> = {}) {
  const db = recorderDatabase(tenant);
  const queue = await browserUploadQueue(session, device, true, tenant);
  if (["complete","uploaded"].includes(queue.state)) return {ready:true,uploaded:true,queued:false,queue};
  if (!queue.allowed) return {ready:false,queued:true,queue};
  const lease = randomUUID();
  const locked = await db.from("browser_recordings").update({lease_token:lease,lease_until:new Date(Date.now()+120000).toISOString()})
    .eq("session_id",session).eq("device_id",device).eq("upload_state","uploading")
    .or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`).select("file_id,bytes,mime_type,recording_sessions(capture_inspection_required)").maybeSingle();
  if (locked.error || !locked.data) throw new UploadRequestError("Upload is busy. Retry shortly.");
  try {
    const b = locked.data;
    const recording = b.recording_sessions as unknown as {capture_inspection_required:boolean} | null;
    if (recording?.capture_inspection_required)
      throw new UploadRequestError("Inspect the interrupted recording before uploading. The local backup is retained.");
    const bytes = Number(b.bytes);
    if (!b.file_id || !Number.isSafeInteger(bytes) || bytes<1 || bytes>R2_MAX_BYTES || b.mime_type!=="video/mp4")
      throw new UploadRequestError("Save a valid MP4 recording before uploading.");
    const store = r2Store();
    const found = await db.from("r2_upload_attempts").select("*").eq("session_id",session)
      .in("state",["creating","uploading","completed"]).order("created_at",{ascending:false}).limit(1).maybeSingle();
    if (found.error) throw found.error;
    let attempt = found.data as Attempt | null;
    let head = attempt ? await store.head(attempt) : null;
    if (attempt && head) assertHead(head,attempt);
    // Recover an ambiguous multipart completion before considering a restart.
    if (attempt && !head && (action==="restart-upload" || attempt.state==="creating")) {
      const retired = await db.from("r2_upload_attempts").update({state:"aborting",updated_at:new Date().toISOString()}).eq("id",attempt.id);
      if (retired.error) throw retired.error;
      await store.abort(attempt);
      const aborted = await db.from("r2_upload_attempts").update({state:"aborted",updated_at:new Date().toISOString()}).eq("id",attempt.id);
      if (aborted.error) throw aborted.error;
      attempt = null;
    }
    if (!attempt) {
      if (["finish","upload-status","upload-part"].includes(action)) return {expired:true};
      const id = randomUUID();
      attempt = {id,session_id:session,tenant_id:tenant,bucket:store.bucket,
        object_key:`tenants/${tenant}/recordings/${session}/${id}.mp4`,upload_id:null,bytes,state:"creating"};
      const inserted = await db.from("r2_upload_attempts").insert({...attempt,device_id:device,mime_type:"video/mp4",part_size:R2_PART_SIZE});
      if (inserted.error) throw inserted.error;
      attempt.upload_id = await store.create(attempt,{attempt:id,session,tenant});
      const saved = await db.from("r2_upload_attempts").update({upload_id:attempt.upload_id,state:"uploading",updated_at:new Date().toISOString()}).eq("id",id);
      if (saved.error) { await store.abort(attempt); throw saved.error; }
      attempt.state="uploading";
      const reset = await db.from("browser_recordings").update({uploaded_bytes:0})
        .eq("session_id",session).eq("lease_token",lease).eq("upload_state","uploading");
      if (reset.error) throw reset.error;
    }
    if (Number(attempt.bytes)!==bytes) throw new UploadRequestError("Upload size changed. Retry the saved recording.");
    const grant = {protocol:R2_UPLOAD_PROTOCOL,attemptId:attempt.id,partSize:R2_PART_SIZE,bytes,mime:"video/mp4"};
    if (["upload","retry-upload","restart-upload"].includes(action)) return {ready:false,queued:false,queue,upload:grant};
    if (input.attempt_id !== attempt.id) throw new UploadRequestError("Upload attempt changed. Prepare the upload again.");
    let progress;
    try { progress = head ? {offset:bytes,uploaded:true,parts:[]} : confirmedParts(await store.parts(attempt),bytes); }
    catch(error) { if (missingUpload(error)) return {expired:true}; throw error; }
    const report = await db.rpc("report_browser_upload",{p_session:session,p_device:device,p_state:"uploading",p_uploaded_bytes:progress.offset});
    if (report.error || !report.data) throw new UploadRequestError("Upload was paused. Sync the saved video before retrying.");
    const touched = await db.from("r2_upload_attempts").update({updated_at:new Date().toISOString()}).eq("id",attempt.id);
    if (touched.error) throw touched.error;
    if (action==="upload-status") return {...grant,offset:progress.offset,uploaded:progress.uploaded};
    if (action==="upload-part") {
      const number = Number(input.part_number);
      if (progress.uploaded) return {...grant,uploaded:true,offset:bytes};
      if (!Number.isSafeInteger(number) || number!==progress.parts.length+1)
        throw new UploadRequestError("Upload progress changed. Check the confirmed offset before sending the next part.");
      const length = Math.min(R2_PART_SIZE,bytes-progress.offset);
      return {...grant,partNumber:number,offset:progress.offset,length,url:await store.partUrl(attempt,number,length)};
    }
    if (action!=="finish") throw new UploadRequestError("Unknown upload action.");
    if (!progress.uploaded) throw new UploadRequestError("Upload is not complete. The local backup is retained.");
    // Cancellation may revoke the lease while R2 is responding. Check again
    // before completion; the atomic RPC below also checks after the side effect.
    const live = await db.from("browser_recordings").select("session_id").eq("session_id",session)
      .eq("lease_token",lease).eq("upload_state","uploading").gt("lease_until",new Date(Date.now()+30000).toISOString()).maybeSingle();
    if (live.error || !live.data) throw new UploadRequestError("Upload was paused before confirmation.");
    if (!head) {
      try { await store.complete(attempt,progress.parts); }
      catch(error) {
        // A lost response can mean completion succeeded. HEAD is authoritative.
        head = await store.head(attempt);
        if (!head) throw error;
      }
      head ||= await store.head(attempt);
    }
    if (!head) throw new UploadRequestError("Storage confirmation is pending. Retry the saved video.");
    assertHead(head,attempt);
    const finished = await db.rpc("finish_r2_upload",{p_session:session,p_device:device,p_attempt:attempt.id,p_lease:lease,p_etag:head.ETag,p_bytes:bytes});
    if (finished.error || !finished.data) throw new UploadRequestError("Upload confirmation is pending. Retry the saved video.");
    return {ready:true,uploaded:true,queued:false,queue:{...queue,state:"uploaded",percent:100}};
  } catch(error) {
    if (error instanceof UploadRequestError) throw error;
    // SDK/network errors may contain signed addresses. Keep them out of UI/logs.
    throw new UploadRequestError("Private storage is temporarily unavailable. Your local recording is retained; retry shortly.");
  } finally {
    await db.from("browser_recordings").update({lease_until:null}).eq("session_id",session).eq("lease_token",lease);
  }
}
