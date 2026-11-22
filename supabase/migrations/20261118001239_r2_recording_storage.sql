-- Additive: historical Drive IDs and replay links remain unchanged.
alter table public.recording_files
  add column storage_provider text not null default 'drive' check(storage_provider in ('drive','r2')),
  add column storage_bucket text,
  add column storage_key text,
  add column storage_etag text,
  add constraint r2_ready_identity check(storage_provider <> 'r2' or status <> 'ready' or
    (storage_bucket is not null and storage_key is not null and storage_etag is not null and bytes > 0));
create unique index recording_files_r2_key on public.recording_files(storage_bucket,storage_key)
  where storage_provider='r2';

create table public.r2_upload_attempts (
  id uuid primary key,
  tenant_id uuid not null default public.current_tenant_id() references public.tenants(id),
  session_id uuid not null,
  device_id uuid,
  bucket text not null,
  object_key text not null,
  upload_id text,
  bytes bigint not null check(bytes between 1 and 85899345920),
  mime_type text not null check(mime_type='video/mp4'),
  part_size integer not null default 8388608 check(part_size=8388608),
  state text not null check(state in ('creating','uploading','completed','aborting','aborted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id), unique(bucket,object_key),
  foreign key(tenant_id,session_id) references public.recording_sessions(tenant_id,id),
  foreign key(tenant_id,device_id) references public.browser_devices(tenant_id,id) on delete set null(device_id)
);
create unique index r2_one_active_attempt on public.r2_upload_attempts(session_id)
  where state in ('creating','uploading');
create index r2_attempts_cleanup on public.r2_upload_attempts(state,updated_at);
create index r2_attempts_tenant_session on public.r2_upload_attempts(tenant_id,session_id);
create index r2_attempts_device on public.r2_upload_attempts(tenant_id,device_id);
alter table public.r2_upload_attempts enable row level security;
revoke all on public.r2_upload_attempts from public,anon,authenticated;
grant select,insert,update,delete on public.r2_upload_attempts to service_role,dinkvision_executor;
create policy r2_attempts_executor on public.r2_upload_attempts to dinkvision_executor
  using(tenant_id=public.current_tenant_id()) with check(tenant_id=public.current_tenant_id());
create trigger keep_tenant_identity before update of tenant_id on public.r2_upload_attempts
  for each row execute function public.keep_tenant_identity();

create function public.finish_r2_upload(p_session uuid,p_device uuid,p_attempt uuid,p_lease uuid,p_etag text,p_bytes bigint)
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
  if a.state<>'uploading' or b.upload_state<>'uploading' or s.status not in ('uploading','sharing')
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

create or replace function public.guard_completed_browser_upload()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.recording_sessions s join public.recording_files f on f.session_id=s.id
    where s.id=new.session_id and s.status='ready' and f.status='ready'
      and (f.drive_file_id is not null or (f.storage_provider='r2' and f.storage_key is not null and f.storage_etag is not null))) then
    new.upload_state:='uploaded'; new.uploaded_bytes:=coalesce(new.bytes,0);
    new.safe_error:=null; new.last_error:=null;
  end if;
  return new;
end; $$;

-- New Gmail-only connection, independent from legacy Drive configuration.
alter table public.tenant_google_settings alter column root_folder_id drop not null;
create table public.gmail_integrations (
  tenant_id uuid primary key references public.tenants(id),
  owner_email text not null,
  refresh_token_encrypted text not null,
  connected_at timestamptz not null default now(),
  safe_error text
);
alter table public.gmail_integrations enable row level security;
revoke all on public.gmail_integrations from public,anon,authenticated;
grant select,insert,update,delete on public.gmail_integrations to service_role;
create trigger keep_tenant_identity before update of tenant_id on public.gmail_integrations
  for each row execute function public.keep_tenant_identity();

-- Explicit exposure; new Supabase projects may not have historical defaults.
grant select on public.profiles,public.recording_sessions,public.recording_files,
  public.delivery_attempts,public.audit_events to authenticated;
grant select,insert,update,delete on public.profiles to service_role;
-- Trigger functions are never client-callable API operations.
revoke execute on function public.audit_configuration(),public.create_player_profile(),
  public.preserve_court_history_before_delete(),public.protect_recording_camera(),
  public.guard_completed_browser_upload() from public,anon,authenticated;
revoke execute on function public.is_admin() from public,anon;
