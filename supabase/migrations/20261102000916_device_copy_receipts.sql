-- Historical confirmation of a successful device-owned Gallery/Files export.
-- No private Android URI or filesystem path is sent to the server.
alter table public.browser_recordings
  add column if not exists device_copy_saved_at timestamptz,
  add column if not exists device_copy_bytes bigint check (device_copy_bytes is null or device_copy_bytes>=0);
