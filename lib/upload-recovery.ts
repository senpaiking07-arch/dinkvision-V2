type RecoveryRecording = {
  upload_state?: string;
  file_id?: string | null;
  bytes?: number | string | null;
  local_available?: boolean;
  recording_sessions?: {
    status?: string;
    stopped_at?: string | null;
    failure_stage?: string | null;
    capture_inspection_required?: boolean;
  } | null;
};

export function videoRetryLabel(recording?: RecoveryRecording | null, nativeRecorder = false) {
  if (recording?.upload_state !== "failed" || recording.local_available !== true)
    return null;
  const session = recording.recording_sessions;
  if (session?.capture_inspection_required) return null;
  const uploadFailed = session?.status === "failed" &&
    ["upload", "upload_cancelled"].includes(session.failure_stage || "");
  if (recording.file_id) {
    const ended = ["uploading", "sharing"].includes(session?.status || "") || uploadFailed;
    return ended && Number(recording.bytes || 0) > 0 ? "Retry upload" : null;
  }
  if (!nativeRecorder) return null;
  const ended = session?.status === "uploading" || uploadFailed ||
    (session?.status === "failed" && session.failure_stage === "browser_capture");
  return ended && session?.stopped_at ? "Retry processing" : null;
}
