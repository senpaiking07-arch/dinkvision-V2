create table public.court_recording_logos (
  tenant_id uuid not null default public.current_tenant_id(),
  court_id uuid not null,
  version uuid not null default gen_random_uuid(),
  png bytea not null check (octet_length(png) between 8 and 524288),
  primary key (tenant_id, court_id),
  foreign key (tenant_id, court_id) references public.courts(tenant_id, id) on delete cascade
);

alter table public.court_recording_logos enable row level security;
revoke all on public.court_recording_logos from public, anon, authenticated;
grant select, insert, update, delete on public.court_recording_logos to service_role;
grant select (tenant_id, court_id, version) on public.court_recording_logos to dinkvision_executor;
create policy court_logo_executor_read on public.court_recording_logos for select
  to dinkvision_executor using (tenant_id = public.current_tenant_id());

create function public.snapshot_court_recording_logo() returns trigger
language plpgsql set search_path = '' as $$
declare
  logo_version uuid;
begin
  if new.configuration_snapshot->>'capture_mode' = 'browser' then
    select version into logo_version from public.court_recording_logos
    where tenant_id = new.tenant_id and court_id = new.court_id;
    new.configuration_snapshot := new.configuration_snapshot - 'court_logo_version';
    if logo_version is not null then
      new.configuration_snapshot := new.configuration_snapshot ||
        jsonb_build_object('court_logo_version', logo_version);
    end if;
  end if;
  return new;
end $$;
revoke all on function public.snapshot_court_recording_logo() from public, anon, authenticated;

create trigger court_recording_logo_snapshot before insert on public.recording_sessions
for each row execute function public.snapshot_court_recording_logo();
