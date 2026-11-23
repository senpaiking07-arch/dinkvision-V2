import { uploadPercent } from "./recording-size";

type LocalVideoReport = {branding_state?: string | null;local_available?: boolean;upload_state?: string|null;last_seen_at?: string | null;branding_updated_at?: string|null;upload_updated_at?: string | null;upload_retry_at?:string|null;last_error?:string|null;device_copy_saved_at?:string|null};

export function localProcessingLabel(item: LocalVideoReport, now: number) {
  if (item.local_available === false) return item.upload_state === 'uploaded' ? "Private upload copy released"
    : item.last_error?.startsWith('App copy removed by user.') ? "App copy removed"
    : item.device_copy_saved_at ? "App copy unavailable · export recorded" : "File missing on device";
  if (item.branding_state !== "processing") return "";
  // Admin retry requests also update upload_updated_at. Only a device's
  // processing report is evidence that logo work is still running.
  const checked = Date.parse(item.branding_updated_at || item.last_seen_at || "") || 0;
  if (checked > 0 && checked <= now + 30000 && now - checked <= 45000) return "Adding logo";
  const presence = Date.parse(item.last_seen_at || "") || 0;
  // A queue-presence heartbeat after a restart proves the file is waiting,
  // not that the interrupted encoder is still running at its old percentage.
  if (presence > checked && presence <= now + 30000 && now - presence <= 45000
      && ['saved_locally','pending','queued','retrying'].includes(item.upload_state || ''))
    return "Waiting to add logo";
  return "Waiting for device · file check pending";
}

export function reportedBrandingProgress(item: {branding_progress?:unknown}) {
  return typeof item.branding_progress === 'number' && Number.isInteger(item.branding_progress)
    && item.branding_progress>=0 && item.branding_progress<=100 ? Math.min(99,item.branding_progress) : null;
}

export function recordingStageLabel(item: LocalVideoReport & {branding_progress?:unknown;bytes?:unknown;uploaded_bytes?:unknown;recording_sessions?:{capture_inspection_required?:boolean;status?:string}|null}, now:number, nativeRecorder=true) {
  if (item.upload_state === 'uploaded')
    return item.local_available === false ? 'Uploaded · private upload copy released' : 'Uploaded';
  const local = localProcessingLabel(item, now);
  if (item.local_available === false) return local;
  if (item.recording_sessions?.capture_inspection_required) return "Interrupted video · inspection required";
  if (item.recording_sessions?.status === 'finalizing' && item.branding_state !== 'processing'
      && !['queued','uploading','uploaded'].includes(item.upload_state || ''))
    return 'Finalizing recording';
  if (item.branding_state === 'processing') {
    const progress = reportedBrandingProgress(item);
    return local === 'Adding logo' && progress !== null ? `Adding logo ${progress}%` : local;
  }
  if (item.upload_state === 'failed' || item.upload_state === 'retrying') {
    if (item.upload_state === 'retrying' && item.upload_retry_at !== undefined
        && !(Date.parse(item.upload_retry_at || '') > now))
      return nativeRecorder && item.branding_state !== 'complete' ? 'Waiting to add logo' : 'Waiting to upload';
    const stage = item.branding_state === 'failed' ? 'Logo processing' : 'Upload';
    return item.upload_state === 'retrying' ? `${stage} retry scheduled` : `${stage} failed`;
  }
  if (item.upload_state === 'uploading') {
    const percent = uploadPercent(item.uploaded_bytes, item.bytes);
    if (percent === 100) return "Verifying upload";
    return percent === undefined ? "Uploading" : `Uploading ${percent}%`;
  }
  if (['saved_locally','pending','queued'].includes(item.upload_state || ''))
    return nativeRecorder && item.branding_state !== 'complete' ? 'Waiting to add logo' : 'Waiting to upload';
  return item.upload_state === 'local_only' ? 'Local-only' : (item.upload_state || '').replaceAll('_',' ');
}
