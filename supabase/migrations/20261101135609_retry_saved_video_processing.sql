-- Native branding/validation can fail before an immutable upload file exists.
-- Requeue the original tablet's local work without creating a cloud upload or
-- modifying the saved footage, recipients, or session identity.
create or replace function public.retry_browser_upload(p_session uuid,p_device uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare changed uuid; local_processing boolean;
begin
  perform 1 from public.venue_settings where id=true for update;
  select exists(
    select 1 from public.browser_recordings b
    join public.recording_sessions s on s.id=b.session_id
    join public.browser_devices d on d.id=b.device_id and d.kiosk_id=s.kiosk_id
    join public.kiosk_devices k on k.id=d.kiosk_id and k.active
    where b.session_id=p_session and b.device_id=p_device
      and b.file_id is null and b.local_available and d.enabled
      and d.recorder_mode='android_rtsp' and d.video_device='android-camera-v1'
      and s.stopped_at is not null
      and (s.status='uploading' or (s.status='failed' and s.failure_stage in ('browser_capture','upload','upload_cancelled')))
  ) into local_processing;

  if local_processing then
    update public.browser_recordings
    set upload_state='retrying',upload_updated_at=now(),retry_count=0,
        last_error=null,safe_error=null
    where session_id=p_session and device_id=p_device
      and upload_state in ('failed','cancelled')
    returning session_id into changed;
    if changed is not null then
      update public.recording_sessions set status='uploading',failure_stage=null
      where id=p_session and status='failed';
      return true;
    end if;
    return exists(
      select 1 from public.browser_recordings
      where session_id=p_session and device_id=p_device
        and upload_state in ('pending','retrying')
    );
  end if;

  update public.browser_recordings b
  set upload_state='retrying',upload_queued_at=now(),upload_started_at=null,
      upload_updated_at=now(),retry_count=0,last_error=null,safe_error=null
  where b.session_id=p_session and b.device_id=p_device
    and b.upload_state in ('failed','cancelled') and b.file_id is not null
    and exists(
      select 1 from public.recording_sessions s where s.id=b.session_id
        and (s.status in ('uploading','sharing') or
          (s.status='failed' and s.failure_stage in ('upload','upload_cancelled')))
    )
  returning b.session_id into changed;
  if changed is not null then
    update public.recording_sessions set status='uploading',failure_stage=null
    where id=p_session and status='failed' and failure_stage in ('upload','upload_cancelled');
    return true;
  end if;
  return exists(
    select 1 from public.browser_recordings b
    join public.recording_sessions s on s.id=b.session_id
    where b.session_id=p_session and b.device_id=p_device and b.file_id is not null
      and b.upload_state in ('pending','retrying','uploading','uploaded')
      and s.status in ('uploading','sharing','ready')
  );
end; $$;

revoke all on function public.retry_browser_upload(uuid,uuid) from public,anon,authenticated;
grant execute on function public.retry_browser_upload(uuid,uuid) to service_role;
