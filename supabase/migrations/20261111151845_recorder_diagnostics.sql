-- Additive diagnostics only. Apply before enabling RECORDER_DIAGNOSTICS_ENABLED.
-- Keep device/session identifiers after removal so historical incidents remain traceable.
create table public.recorder_diagnostics (
  tenant_id uuid not null references public.tenants(id),
  device_id uuid not null,
  event_id uuid not null,
  attempt_id uuid not null,
  session_id uuid,
  operation text not null check(operation in ('capture','upload')),
  stage text not null check(stage in ('work_queue','release_check','reconcile','reserve','camera_prepare','countdown','capture','finalize','validate','saved_report','branding','transfer','queue_wait','cleanup','complete')),
  result text not null check(result in ('ok','failed','waiting')),
  code text not null check(code in ('none','timeout','dns','tls','connection','http_client','http_server','validation','device_or_storage','unknown')),
  elapsed_ms bigint not null check(elapsed_ms between 0 and 604800000),
  duration_ms bigint not null check(duration_ms between 0 and 604800000),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  queue_count integer not null check(queue_count between 0 and 10000),
  bytes bigint not null check(bytes between 0 and 1000000000000),
  retry_count integer not null check(retry_count between 0 and 1000),
  version_code integer not null check(version_code>=0),
  primary key (tenant_id,device_id,event_id)
);
create index recorder_diagnostics_session on public.recorder_diagnostics(tenant_id,session_id,received_at desc);
create index recorder_diagnostics_device on public.recorder_diagnostics(tenant_id,device_id,received_at desc);
create index recorder_diagnostics_attempt on public.recorder_diagnostics(tenant_id,device_id,attempt_id);
alter table public.recorder_diagnostics enable row level security;
revoke all on public.recorder_diagnostics from public,anon,authenticated;
grant select on public.recorder_diagnostics to authenticated;
grant select,insert on public.recorder_diagnostics to service_role;
create policy recorder_diagnostics_admin_read on public.recorder_diagnostics for select to authenticated
  using (tenant_id=(select public.current_tenant_id()) and public.is_tenant_admin(tenant_id));
