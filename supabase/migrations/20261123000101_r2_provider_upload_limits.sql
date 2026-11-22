-- R2's multipart object limit is 5 TiB minus 5 GiB. Legacy attempts keep their part sizes.
alter table public.r2_upload_attempts
  drop constraint r2_upload_attempts_bytes_check,
  drop constraint r2_upload_attempts_part_size_check,
  add constraint r2_upload_attempts_bytes_check check(bytes between 1 and 5492189429760),
  add constraint r2_upload_attempts_part_size_check check(
    part_size in (8388608, 16777216, 33554432) or
    (part_size between 34603008 and 549453824 and part_size % 1048576 = 0)
  );

-- Preserve the service-only function's ownership, grants and transition checks.
create or replace function public.browser_event(
  p_kiosk uuid,p_session uuid,p_action text,p_bytes bigint default null,p_mime text default null
) returns boolean language plpgsql security definer set search_path='' as $$
declare s public.recording_sessions; b public.browser_recordings; f uuid; device uuid;
begin
 select id into device from public.browser_devices where kiosk_id=p_kiosk and enabled for update;
 if not found then return false; end if;
 perform 1 from public.kiosk_devices where id=p_kiosk and active for update;
 if not found then return false; end if;
 select * into s from public.recording_sessions where id=p_session and kiosk_id=p_kiosk for update;
 if not found then return false; end if;
 select * into b from public.browser_recordings where session_id=p_session and device_id=device for update;
 if not found then return false; end if;
 update public.browser_recordings set last_seen_at=now() where session_id=p_session;
 if p_action='started' then
  if s.status='recording' then return true; end if;
  if s.status<>'requested' then return false; end if;
  update public.recording_sessions set status='recording',started_at=now() where id=p_session;
 elsif p_action='stopped' then
  if s.status='finalizing' then return true; end if;
  if s.status not in ('requested','recording') then return false; end if;
  update public.recording_sessions set status='finalizing',started_at=coalesce(started_at,now()),stopped_at=coalesce(stopped_at,now()) where id=p_session;
 elsif p_action='captured' then
  if s.status in ('uploading','sharing','ready') then
   update public.kiosk_devices set current_session_id=null where id=p_kiosk and current_session_id=p_session;
   return true;
  end if;
  if s.status not in ('requested','recording','finalizing') then return false; end if;
  update public.recording_sessions set status='uploading',started_at=coalesce(started_at,now()),
    stopped_at=coalesce(stopped_at,now()),failure_stage=null where id=p_session;
  update public.browser_recordings set
    upload_state=case when file_id is null and upload_state in ('idle','saved_locally') then 'saved_locally' else upload_state end,
    upload_updated_at=now(),client_created_at=coalesce(client_created_at,s.created_at),safe_error=null
    where session_id=p_session;
  update public.kiosk_devices set current_session_id=null where id=p_kiosk and current_session_id=p_session;
 elsif p_action='saved' then
  if p_bytes is null or p_bytes<1 or p_bytes>5492189429760 or p_mime not in ('video/webm','video/mp4') then raise exception 'Invalid recording'; end if;
  if b.file_id is not null then return b.bytes=p_bytes and b.mime_type=p_mime; end if;
  if s.status not in ('requested','recording','finalizing','uploading','failed') then return false; end if;
  insert into public.recording_files(session_id,status,bytes) values(p_session,'local_ready',p_bytes) returning id into f;
  update public.browser_recordings set file_id=f,bytes=p_bytes,mime_type=p_mime,safe_error=null,last_error=null,
    upload_state='saved_locally',upload_updated_at=now(),client_created_at=coalesce(client_created_at,s.created_at)
    where session_id=p_session;
  update public.recording_sessions set status='uploading',stopped_at=coalesce(stopped_at,now()),failure_stage=null where id=p_session;
  update public.kiosk_devices set current_session_id=null where id=p_kiosk and current_session_id=p_session;
 elsif p_action='failed' then
  if s.status not in ('requested','recording','finalizing') then return false; end if;
  update public.recording_sessions set status='failed',stopped_at=coalesce(stopped_at,now()),failure_stage='browser_capture' where id=p_session;
  update public.browser_recordings set upload_state='failed',last_error='Recording was interrupted.',safe_error='Recording was interrupted.',upload_updated_at=now() where session_id=p_session;
  update public.kiosk_devices set current_session_id=null where id=p_kiosk and current_session_id=p_session;
 elsif p_action='reset' then
  if s.status not in ('ready','failed','deleted') then return false; end if;
  update public.kiosk_devices set current_session_id=null where id=p_kiosk and current_session_id=p_session;
 elsif p_action='heartbeat' then
  perform public.release_stopped_browser_captures(p_kiosk);
 elsif p_action<>'heartbeat' then return false;
 end if;
 return true;
end; $$;

-- Allow larger transfers time to send a part before releasing a stalled queue.
create or replace function public.expire_browser_uploads(p_device uuid default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  update public.browser_recordings b set upload_state='failed',lease_until=null,
    lease_token=null,upload_updated_at=now(),
    last_error='Upload connection expired. Local footage is retained for recovery.',
    safe_error='Upload connection expired. Local footage is retained for recovery.'
  where (p_device is null or b.device_id=p_device)
    and b.upload_state in ('pending','queued','retrying','uploading')
    and coalesce(b.upload_updated_at,b.upload_queued_at,b.last_seen_at)<now()-(
      case when b.upload_state='uploading' and b.bytes>335544320000
        then interval '15 minutes' else interval '3 minutes' end)
    and (b.upload_state='uploading' or b.upload_retry_at is null or b.upload_retry_at<=now())
    and (b.upload_state='uploading' or b.last_seen_at is null or b.last_seen_at<now()-interval '3 minutes')
    and (b.lease_until is null or b.lease_until<now())
    and exists(select 1 from public.recording_sessions s where s.id=b.session_id and s.status in ('uploading','sharing'));
end; $$;
