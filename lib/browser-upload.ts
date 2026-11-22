import "server-only";
import { recorderDatabase } from "./recorder-server";

export type BrowserUploadQueue = {
  allowed: boolean;
  state:
    | "idle"
    | "queued"
    | "saved_locally"
    | "pending"
    | "uploading"
    | "retrying"
    | "uploaded"
    | "failed"
    | "cancelled"
    | "local_only"
    | "complete";
  position: number;
  total: number;
  activeSession: string | null;
  activeDevice: string | null;
  activeCourt: string | null;
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
  blocked: boolean;
};

function publicQueue(row: any): BrowserUploadQueue {
  return {
    allowed: !!row.allowed,
    state: row.upload_state,
    position: Number(row.queue_position || 0),
    total: Number(row.queue_total || 0),
    activeSession: row.active_session || null,
    activeDevice: row.active_device_name || null,
    activeCourt: row.active_court_name || null,
    uploadedBytes: Number(row.active_uploaded_bytes || 0),
    totalBytes: Number(row.active_total_bytes || 0),
    percent: Number(row.active_percent || 0),
    blocked: !!row.blocked_by_failure,
  };
}

export async function browserUploadQueue(
  sessionId: string,
  deviceId: string,
  claim = false,
  tenantId?: string,
) {
  const db = recorderDatabase(tenantId);
  const result = await db.rpc("browser_upload_turn", {
    p_session: sessionId,
    p_device: deviceId,
    p_claim: claim,
  });
  if (result.error)
    throw new Error("Apply the latest database migration for upload queuing.");
  const row = result.data?.[0];
  if (!row) throw new Error("This recording is not available in the upload queue.");
  return publicQueue(row);
}

export async function browserUploadStatus(_sessionId: string, _deviceId: string) {
  throw new Error("Legacy direct upload status is unavailable. Use R2 upload.");
}

export async function browserUploadChunk(..._args: unknown[]) {
  throw new Error("Legacy direct upload chunks are unavailable. Use R2 upload.");
}

export async function browserUpload(..._args: unknown[]) {
  return { ready: false, queued: false, unsupported: true };
}
