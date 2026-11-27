import { ArrowUpRight, CloudUpload, RotateCcw } from "lucide-react";
import { captureInterruptionLabel } from "@/lib/capture-interruption";
import { deviceQueueOrder, isLocalOnlyHistory, isQueuedWork, visibleDeviceQueueItem } from "@/lib/device-queue-order";
import { localProcessingLabel, recordingStageLabel, reportedBrandingProgress } from "@/lib/local-video-status";
import { recordingDisplayLabel } from "@/lib/recording-label";
import { reportedFailure } from "@/lib/recording-diagnostics";
import { recordingSizeMb, uploadPercent, uploadSizeMb } from "@/lib/recording-size";
import { videoRetryLabel } from "@/lib/upload-recovery";
import type { AdminDevice, DeviceRecording } from "./admin-device-types";

export function formatDeviceTime(value?: string | null, zone?: string) {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) return null;
  const options = { dateStyle: "medium", timeStyle: "short" } as const;
  try { return new Intl.DateTimeFormat("en-PH", { ...options, timeZone: zone }).format(date); }
  catch { return new Intl.DateTimeFormat("en-PH", { ...options, timeZone: "UTC" }).format(date); }
}

export function uploadCounts(recordings: DeviceRecording[]) {
  const failed = recordings.filter(row => row.upload_state === "failed");
  const uploading = recordings.filter(row => row.upload_state === "uploading");
  const waiting = recordings.filter(row => isQueuedWork(row) && row.upload_state !== "uploading");
  return { failed: failed.length, uploading: uploading.length, waiting: waiting.length };
}

type Props = {
  device: AdminDevice;
  recordings: DeviceRecording[];
  zone?: string;
  now: number;
  busy: boolean;
  onRetry: (id: string) => void;
  onCancel: (recording: DeviceRecording) => void;
  onRetryEmail: (id: string) => void;
};

export default function AdminDeviceQueue({ device, recordings, now, zone, busy, onRetry, onCancel, onRetryEmail }: Props) {
  const activeRows = deviceQueueOrder(recordings.filter(row =>
    ["saved_locally", "pending", "queued", "retrying", "uploading", "failed", "local_only"].includes(row.upload_state)
    && visibleDeviceQueueItem(row, now)
  ), now);
  const history = activeRows.filter(isLocalOnlyHistory);
  const active = activeRows.filter(row => !isLocalOnlyHistory(row));
  const { failed, uploading, waiting } = uploadCounts(active);
  const emailIssues = recordings.flatMap(item => {
    if (item.upload_state !== "uploaded") return [];
    const file = item.recording_sessions?.recording_files?.find(row =>
      row.status === "ready" && row.storage_provider === "r2" && row.storage_key);
    const job = Array.isArray(file?.email_jobs) ? file.email_jobs[0] : file?.email_jobs;
    return file && (job?.status === "failed" || job?.status === "unknown")
      ? [{ item, file, status: job.status }] : [];
  });

  function uploadRow(item: DeviceRecording) {
    const label = recordingDisplayLabel(item.recording_sessions, item.client_created_at, zone);
    const interruption = captureInterruptionLabel(item.recording_sessions?.capture_interruption_code);
    const stage = recordingStageLabel(item, now, device.recorder_mode === "android_rtsp");
    const isUploading = item.upload_state === "uploading";
    const isFailed = item.upload_state === "failed";
    const processing = item.branding_state === "processing" && item.local_available !== false;
    const branding = reportedBrandingProgress(item);
    const retryAt = Date.parse(item.upload_retry_at || "");
    const retry = videoRetryLabel(item, device.recorder_mode === "android_rtsp");
    const cancellable = !!item.file_id && ["queued", "uploading", "failed"].includes(item.upload_state);
    const percent = uploadPercent(item.uploaded_bytes, item.bytes);
    return <li className="recorder-upload-row" key={item.session_id} data-session-id={item.session_id}>
      <div className="recorder-upload-title">
        <a href={`/admin?recording=${encodeURIComponent(item.session_id)}`} title={label.full} aria-label={`Open recording log for ${label.full}`}>
          <strong>{label.recipients}</strong><ArrowUpRight size={14} aria-hidden="true" />
        </a>
        <span>{label.date}</span>
      </div>
      <span className={`recorder-state ${isFailed ? "is-danger" : isUploading ? "is-live" : ""}`}>{stage}</span>
      <div className="recorder-upload-meta">
        <span>{isUploading && !processing ? uploadSizeMb(item.uploaded_bytes, item.bytes) : `${processing ? "Source video" : "Video size"} · ${recordingSizeMb(item.bytes)}`}</span>
        {item.local_available === true && <span>Saved on recorder</span>}
        {item.upload_state === "retrying" && retryAt > now && <span>Next retry · {formatDeviceTime(item.upload_retry_at, zone)}</span>}
        {!!item.retry_count && (isFailed || item.upload_state === "retrying") && <span>{item.retry_count} {item.retry_count === 1 ? "retry" : "retries"}</span>}
        {item.device_copy_saved_at && <span>Exported · {formatDeviceTime(item.device_copy_saved_at, zone)}</span>}
      </div>
      {(isUploading || processing) && <div className="recorder-upload-progress">
        <progress max={100} value={processing ? branding ?? undefined : percent} aria-label={`${processing ? "Logo" : "Upload"} progress for ${label.full}`} />
        {processing && localProcessingLabel(item, now) !== "Adding logo" && branding !== null && <span>Last reported {branding}%</span>}
      </div>}
      {interruption && <p className="recorder-upload-note">Capture ended early · {interruption}</p>}
      {item.recording_sessions?.capture_inspection_required && item.local_available !== false
        ? <p className="recorder-upload-note">Open Saved videos on the recorder and save an original copy for inspection.</p>
        : (isFailed || item.upload_state === "retrying") && (item.last_error || item.safe_error) &&
          <p className="recorder-upload-note">{reportedFailure(item.last_error, item.safe_error)}</p>}
      {(retry || cancellable) && <div className="recorder-upload-actions">
        {retry && <button className="secondary" type="button" disabled={busy} onClick={() => onRetry(item.session_id)}
          aria-label={`${retry} for ${label.full}`}><RotateCcw size={14} aria-hidden="true" />{retry}</button>}
        {cancellable && <button className="recorder-text-action" type="button" disabled={busy}
          onClick={() => onCancel(item)} aria-label={`Cancel upload for ${label.full}`}>Cancel upload</button>}
      </div>}
    </li>;
  }

  return <section className="recorder-upload-panel" aria-label="Upload queue">
    <div className="recorder-detail-section-heading">
      <div><h4><CloudUpload size={19} aria-hidden="true" /> Upload queue</h4><p>Progress reported by this recorder.</p></div>
      {!!active.length && <div className="recorder-queue-counts">
        {!!uploading && <span className="recorder-state is-live">{uploading} uploading</span>}
        {!!waiting && <span className="recorder-state">{waiting} waiting</span>}
        {!!failed && <span className="recorder-state is-danger">{failed} failed</span>}
      </div>}
    </div>
    {active.length ? <ul className="recorder-upload-list">{active.map(uploadRow)}</ul>
      : <p className="recorder-empty-queue">No videos waiting to upload.</p>}
    {!!emailIssues.length && <details className="recorder-disclosure">
      <summary>Replay emails needing attention ({emailIssues.length})</summary>
      <ul className="recorder-upload-list">
        {emailIssues.map(({ item, file, status }) => {
          const label = recordingDisplayLabel(item.recording_sessions, item.client_created_at, zone);
          const failedEmail = status === "failed";
          return <li className="recorder-upload-row" key={item.session_id}>
            <div className="recorder-upload-title">
              <a href={`/admin?recording=${encodeURIComponent(item.session_id)}`} title={label.full}>
                <strong>{label.recipients}</strong><ArrowUpRight size={14} aria-hidden="true" />
              </a>
              <span>{label.date}</span>
            </div>
            <span className={`recorder-state ${failedEmail ? "is-danger" : "is-warning"}`}>{failedEmail ? "Replay email failed" : "Replay email needs review"}</span>
            <div className="recorder-upload-meta"><span>Video uploaded</span><span>{recordingSizeMb(item.bytes)}</span></div>
            {failedEmail && <div className="recorder-upload-actions">
              <button className="secondary" type="button" disabled={busy} onClick={() => onRetryEmail(file.id)}>Retry replay email</button>
            </div>}
          </li>;
        })}
      </ul>
    </details>}
    {!!history.length && <details className="recorder-disclosure" aria-label={`${device.name} local-only history`}>
      <summary>Local-only videos ({history.length})</summary>
      <ul className="recorder-upload-list">{history.map(uploadRow)}</ul>
    </details>}
  </section>;
}
