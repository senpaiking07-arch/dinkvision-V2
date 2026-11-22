-- Reconciliation must honor capture inspection as well as explicit client requests.
create or replace function public.finish_r2_upload(p_session uuid,p_device uuid,p_attempt uuid,p_lease uuid,p_etag text,p_bytes bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare b public.browser_recordings; s public.recording_sessions; a public.r2_upload_attempts;
begin
  -- Same lock order as queue/cancel: settings, browser recording, session.
  perform 1 from public.venue_settings where id=true for update;
  select * into b from public.browser_recordings where session_id=p_session and device_id=p_device for update;
  if not found or b.file_id is null then return false; end if;
  select * into s from public.recording_sessions where id=p_session for update;
  select * into a from public.r2_upload_attempts where id=p_attempt and session_id=p_session for update;
  if not found then return false; end if;
  if a.state='completed' and s.status='ready' then return true; end if;
  if s.capture_inspection_required or a.state<>'uploading' or b.upload_state<>'uploading' or s.status not in ('uploading','sharing')
    or b.lease_token is distinct from p_lease or b.lease_until<=now() or b.lease_until is null
    or a.bytes<>p_bytes or b.bytes<>p_bytes or coalesce(length(p_etag),0) not between 1 and 200 then return false; end if;
  update public.recording_files set storage_provider='r2',storage_bucket=a.bucket,storage_key=a.object_key,
    storage_etag=p_etag,status='ready',uploaded_at=now(),
    expires_at=now()+make_interval(secs=>coalesce((s.configuration_snapshot->>'retention_seconds')::integer,86400))
    where id=b.file_id and drive_file_id is null;
  if not found then return false; end if;
  update public.r2_upload_attempts set state='completed',updated_at=now() where id=a.id;
  update public.recording_sessions set status='ready',failure_stage=null where id=p_session;
  update public.browser_recordings set upload_state='uploaded',uploaded_bytes=b.bytes,
    upload_uri_encrypted=null,safe_error=null,last_error=null,upload_updated_at=now() where session_id=p_session;
  insert into public.email_jobs(file_id) values(b.file_id) on conflict do nothing;
  return true;
end; $$;
alter function public.finish_r2_upload(uuid,uuid,uuid,uuid,text,bigint) owner to dinkvision_executor;
revoke all on function public.finish_r2_upload(uuid,uuid,uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.finish_r2_upload(uuid,uuid,uuid,uuid,text,bigint) to service_role;


-- Keep cleanup recoverable when storage deletion succeeds but its response or
-- database confirmation is lost. File, session and audit commit together.
-- A terminal transition releases the upload lease. Subsequent maintenance may
-- acquire a new lease without changing that terminal state.
create or replace function public.release_browser_upload_lease()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.upload_state is distinct from old.upload_state
    and new.upload_state in ('failed','cancelled','uploaded','complete','local_only') then
    new.lease_until:=null;
    new.lease_token:=null;
  end if;
  return new;
end; $$;

create function public.finish_r2_cleanup(p_file uuid,p_lease uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare b public.browser_recordings; f public.recording_files; s public.recording_sessions;
begin
  perform 1 from public.venue_settings where id=true for update;
  select * into b from public.browser_recordings where file_id=p_file for update;
  if not found then return false; end if;
  select * into s from public.recording_sessions where id=b.session_id for update;
  select * into f from public.recording_files where id=p_file and session_id=b.session_id for update;
  if not found or f.storage_provider<>'r2' then return false; end if;
  if f.status='deleted' and s.status='deleted' then return true; end if;
  if f.status<>'deleting' or f.expires_at is null or f.expires_at>now()
    or b.lease_token is distinct from p_lease or b.lease_until is null or b.lease_until<=now() then return false; end if;
  update public.recording_files set status='deleted',deleted_at=now() where id=p_file;
  update public.recording_sessions set status='deleted' where id=b.session_id;
  insert into public.audit_events(session_id,action) values(b.session_id,'retention.r2_cloud_deleted');
  return true;
end; $$;
alter function public.finish_r2_cleanup(uuid,uuid) owner to dinkvision_executor;
revoke all on function public.finish_r2_cleanup(uuid,uuid) from public,anon,authenticated;
grant execute on function public.finish_r2_cleanup(uuid,uuid) to service_role;
