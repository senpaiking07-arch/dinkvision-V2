alter table public.recording_sessions
  add column capture_interruption_code text,
  add column capture_interrupted_at timestamptz,
  add constraint recording_sessions_capture_interruption_check check (
    (capture_interruption_code is null and capture_interrupted_at is null)
    or (capture_interruption_code is not null and capture_interruption_code in (
      'camera_disconnected', 'camera_failure', 'storage_full', 'app_interrupted', 'unknown'
    ))
  );
