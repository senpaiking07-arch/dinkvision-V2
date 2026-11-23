-- Private, receive-only admin notifications. Never expose this schema in the Data API.
create schema dinkvision_realtime;
revoke all on schema dinkvision_realtime from public, anon, authenticated;
grant usage on schema dinkvision_realtime to authenticated;

create function dinkvision_realtime.may_receive(requested_topic text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tenants t
    join auth.users u on u.id = auth.uid() and u.email_confirmed_at is not null
    where t.id = substring(requested_topic from
      '^tenant:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):admin-status$')::uuid
      and t.active and public.is_tenant_admin(t.id)
  );
$$;
revoke all on function dinkvision_realtime.may_receive(text) from public, anon;
grant execute on function dinkvision_realtime.may_receive(text) to authenticated;

create policy dinkvision_admin_receive on realtime.messages for select to authenticated
using (extension = 'broadcast' and topic = (select realtime.topic())
       and dinkvision_realtime.may_receive(topic));

-- Other permissive project policies must never widen access to our namespace.
create policy dinkvision_admin_read_boundary on realtime.messages as restrictive for select to authenticated
using (topic not like 'tenant:%:admin-status' or
       (extension = 'broadcast'
        and topic = (select realtime.topic()) and dinkvision_realtime.may_receive(topic)));
create policy dinkvision_admin_no_anon_read on realtime.messages as restrictive for select to anon
using (topic not like 'tenant:%:admin-status');
create policy dinkvision_admin_no_publish on realtime.messages as restrictive for insert to anon, authenticated
with check (topic not like 'tenant:%:admin-status');
create policy dinkvision_admin_no_update on realtime.messages as restrictive for update to anon, authenticated
using (topic not like 'tenant:%:admin-status') with check (topic not like 'tenant:%:admin-status');
create policy dinkvision_admin_no_delete on realtime.messages as restrictive for delete to anon, authenticated
using (topic not like 'tenant:%:admin-status');

-- A single coalescing cursor per venue. Skipped hints are recovered by normal polling.
create table dinkvision_realtime.venue_cursor (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  version bigint not null, emitted_at timestamptz not null
);
revoke all on dinkvision_realtime.venue_cursor from public, anon, authenticated;

create function dinkvision_realtime.recording_transition() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  stamp timestamptz := clock_timestamp();
  revision bigint;
begin
  if not pg_try_advisory_xact_lock(391754, hashtext(new.tenant_id::text)) then return null; end if;
  insert into dinkvision_realtime.venue_cursor as c values (new.tenant_id,1,stamp)
  on conflict (tenant_id) do update set version=c.version+1, emitted_at=excluded.emitted_at
    where c.emitted_at <= excluded.emitted_at - interval '5 seconds'
  returning version into revision;
  if revision is not null then
    perform realtime.send(jsonb_build_object(
      'schemaVersion',1,'type','recording.transition','tenantId',new.tenant_id,
      'entityId',new.id,'eventId',gen_random_uuid(),'version',revision,
      'occurredAt',stamp), 'recording.transition','tenant:'||new.tenant_id||':admin-status',true);
  end if;
  return null;
exception when others then
  raise warning 'DinkVision recording notification skipped (%)', SQLSTATE;
  return null;
end;
$$;
revoke all on function dinkvision_realtime.recording_transition() from public, anon, authenticated;
create trigger recording_insert_notice after insert on public.recording_sessions
for each row execute function dinkvision_realtime.recording_transition();
create trigger recording_status_notice after update of status on public.recording_sessions
for each row when (old.status is distinct from new.status)
execute function dinkvision_realtime.recording_transition();
