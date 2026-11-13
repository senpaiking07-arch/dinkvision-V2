-- Clients opt in after this additive migration has been applied.
alter table public.browser_recordings add column upload_retry_at timestamptz;

-- Preserve the existing functions' executor ownership and grants.
-- An active transfer holds the tenant's turn while deferred retries yield.
create or replace function public.browser_upload_turn(p_session uuid,p_device uuid,p_claim boolean default false)
returns table(allowed boolean,upload_state text,queue_position integer,queue_total integer,active_session uuid,
 active_device_name text,active_court_name text,active_uploaded_bytes bigint,active_total_bytes bigint,
 active_percent integer,blocked_by_failure boolean)
language plpgsql security definer set search_path='' as $$
declare target public.browser_recordings; head public.browser_recordings; target_status text; head_device text; head_court text;
 position_value integer; total_value integer; tenant_scope uuid;
begin
 select b.tenant_id into tenant_scope from public.browser_recordings b
 where b.session_id=p_session and b.device_id=p_device;
 if tenant_scope is null then return; end if;
 perform 1 from public.venue_settings where tenant_id=tenant_scope and id=true for update;
 if not found then return; end if;
 update public.browser_recordings b set upload_updated_at=now()
 where b.tenant_id=tenant_scope and b.session_id=p_session and b.device_id=p_device
   and b.upload_state in ('pending','queued','retrying','uploading')
   and (b.lease_until is null or b.lease_until<now());
 perform public.expire_browser_uploads(null);
 select * into target from public.browser_recordings where tenant_id=tenant_scope and session_id=p_session and device_id=p_device for update;
 if not found then return; end if;
 select status into target_status from public.recording_sessions where tenant_id=tenant_scope and id=p_session;
 if target_status='ready' or target.upload_state in ('complete','uploaded') then
  return query select true,'uploaded'::text,0,0,null::uuid,null::text,null::text,target.bytes,target.bytes,100,false; return;
 end if;
 if target_status not in ('uploading','sharing') or target.upload_state in ('idle','saved_locally','failed','cancelled','local_only') then
  return query select false,target.upload_state,0,0,null::uuid,null::text,null::text,target.uploaded_bytes,coalesce(target.bytes,0),
   case when coalesce(target.bytes,0)>0 then least(100,floor(target.uploaded_bytes*100.0/target.bytes)::integer) else 0 end,false; return;
 end if;
 select b.* into head from public.browser_recordings b join public.recording_sessions s
   on s.tenant_id=b.tenant_id and s.id=b.session_id
 where b.tenant_id=tenant_scope and s.status in ('uploading','sharing') and b.file_id is not null
   and b.upload_state in ('pending','retrying','uploading')
   and (b.upload_state='uploading' or b.upload_retry_at is null or b.upload_retry_at<=now())
 order by case when b.upload_state='uploading' then 0 else 1 end,b.upload_queued_at,b.client_created_at,s.created_at,b.session_id for update of b limit 1;
 if not found then
  -- A deferred target still has a readable queue state even when no job is eligible.
  return query select false,target.upload_state,0,0,null::uuid,null::text,null::text,
    target.uploaded_bytes,coalesce(target.bytes,0),0,false; return;
 end if;
 select ranked.position,ranked.total into position_value,total_value from (
  select b.session_id,row_number() over(order by case when b.upload_state='uploading' then 0 else 1 end,b.upload_queued_at,b.client_created_at,s.created_at,b.session_id)::integer position,
    count(*) over()::integer total
  from public.browser_recordings b join public.recording_sessions s on s.tenant_id=b.tenant_id and s.id=b.session_id
  where b.tenant_id=tenant_scope and s.status in ('uploading','sharing') and b.file_id is not null
    and b.upload_state in ('pending','retrying','uploading')
   and (b.upload_state='uploading' or b.upload_retry_at is null or b.upload_retry_at<=now())
 ) ranked where ranked.session_id=p_session;
 select coalesce(d.name,'Previous device'),coalesce(c.name,s.configuration_snapshot->>'court_name','Another court') into head_device,head_court
 from public.recording_sessions s
 left join public.browser_devices d on d.tenant_id=s.tenant_id and d.id=head.device_id
 left join public.courts c on c.tenant_id=s.tenant_id and c.id=s.court_id
 where s.tenant_id=tenant_scope and s.id=head.session_id;
 if p_claim and head.session_id=p_session then
  update public.browser_recordings set upload_state='uploading',upload_started_at=coalesce(upload_started_at,now()),
    upload_updated_at=now(),upload_retry_at=null,last_error=null,safe_error=null
  where tenant_id=tenant_scope and session_id=p_session returning * into target;
 else
  select * into target from public.browser_recordings where tenant_id=tenant_scope and session_id=p_session;
 end if;
 return query select head.session_id=p_session and (not p_claim or target.upload_state='uploading'),target.upload_state,
  coalesce(position_value,0),coalesce(total_value,0),head.session_id,head_device,head_court,coalesce(head.uploaded_bytes,0),coalesce(head.bytes,0),
  case when coalesce(head.bytes,0)>0 then least(100,floor(coalesce(head.uploaded_bytes,0)*100.0/head.bytes)::integer) else 0 end,false;
end; $$;

create or replace function public.expire_browser_uploads(p_device uuid default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  update public.browser_recordings b set upload_state='failed',lease_until=null,
    lease_token=null,upload_updated_at=now(),
    last_error='Upload connection expired. Local footage is retained for recovery.',
    safe_error='Upload connection expired. Local footage is retained for recovery.'
  where (p_device is null or b.device_id=p_device)
    and b.upload_state in ('pending','queued','retrying','uploading')
    and coalesce(b.upload_updated_at,b.upload_queued_at,b.last_seen_at)<now()-interval '3 minutes'
    and (b.upload_state='uploading' or b.upload_retry_at is null or b.upload_retry_at<=now())
    and (b.upload_state='uploading' or b.last_seen_at is null or b.last_seen_at<now()-interval '3 minutes')
    and (b.lease_until is null or b.lease_until<now())
    and exists(select 1 from public.recording_sessions s where s.id=b.session_id and s.status in ('uploading','sharing'));
end; $$;

create or replace function public.retry_browser_upload(p_session uuid,p_device uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare changed uuid; local_processing boolean;
begin
  perform 1 from public.venue_settings where id=true for update;
  -- Explicit retry makes deferred work eligible again at the end of the FIFO.
  update public.browser_recordings
  set upload_retry_at=null,
      upload_queued_at=case when upload_retry_at>now() then now() else upload_queued_at end,
      upload_updated_at=now()
  where session_id=p_session and device_id=p_device
    and upload_state in ('pending','retrying') and upload_retry_at is not null;

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

create or replace function public.report_browser_upload(p_session uuid,p_device uuid,p_state text,p_uploaded_bytes bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare b public.browser_recordings; normalized text;
begin
 select * into b from public.browser_recordings where session_id=p_session and device_id=p_device for update;
 normalized:=case p_state when 'complete' then 'uploaded' else p_state end;
 if not found or normalized not in ('uploading','failed','uploaded') or p_uploaded_bytes<0 or p_uploaded_bytes>coalesce(b.bytes,0) then return false; end if;
 if normalized='uploading' and b.upload_state<>'uploading' then return false; end if;
 -- A delayed failure must not reopen verified Drive footage or undo cancellation.
 if normalized='failed' and (b.upload_state in ('uploaded','complete','cancelled') or exists(
   select 1 from public.recording_sessions s where s.id=p_session and s.tenant_id=b.tenant_id
   and s.status in ('ready','deleted')
 )) then return false; end if;
 update public.browser_recordings set upload_state=normalized,uploaded_bytes=greatest(uploaded_bytes,p_uploaded_bytes),upload_updated_at=now(),
  local_available=case when normalized='uploaded' then false else local_available end,
  last_error=case when normalized='failed' then 'Upload paused on this device.' else null end,
  safe_error=case when normalized='failed' then 'Upload paused on this device.' else null end where session_id=p_session;
 return true;
end; $$;
