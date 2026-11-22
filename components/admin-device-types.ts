import type { DeviceInfo } from "@/lib/device-info";

export type AdminDevice = {
  id: string;
  name: string;
  court_id: string | null;
  kiosk_id?: string | null;
  enabled: boolean;
  last_seen_at?: string | null;
  tested_at?: string | null;
  recorder_mode?: string | null;
  camera_name?: string | null;
  diagnostic?: string | null;
  device_info?: DeviceInfo | null;
};

type EmailJob = { status: string; safe_error?: string | null };

export type DeviceRecording = {
  session_id: string;
  device_id: string;
  file_id?: string | null;
  upload_state: string;
  uploaded_bytes?: number | string | null;
  bytes?: number | string | null;
  upload_updated_at?: string | null;
  upload_queued_at?: string | null;
  upload_retry_at?: string | null;
  retry_count?: number | null;
  last_seen_at?: string | null;
  branding_state?: string | null;
  branding_progress?: number | null;
  branding_updated_at?: string | null;
  local_available?: boolean;
  client_created_at?: string;
  last_error?: string | null;
  safe_error?: string | null;
  device_copy_saved_at?: string | null;
  recording_sessions?: {
    status?: string;
    started_at?: string | null;
    stopped_at?: string | null;
    created_at?: string | null;
    duration_seconds?: number | null;
    recipient_email?: string | null;
    configuration_snapshot?: { recipient_emails?: unknown; venue_time_zone?: string } | null;
    failure_stage?: string | null;
    capture_interruption_code?: string | null;
    capture_inspection_required?: boolean;
    recording_files?: {
      id: string;
      status: string;
      storage_provider?: string;
      storage_key?: string | null;
      email_jobs?: EmailJob | EmailJob[] | null;
    }[];
  } | null;
};

export type AdminDevicesData = {
  devices: AdminDevice[];
  courts: { id: string; name: string; active: boolean }[];
  recordings: DeviceRecording[];
  serverTime?: string;
  workerAt?: string | null;
  timeZone?: string;
  receivedAt?: number;
};
