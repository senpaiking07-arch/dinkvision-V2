create table public.tablet_pairing_requests (
  id uuid primary key,
  claim_hash text not null,
  pin text unique check (pin ~ '^[0-9]{6}$'),
  expires_at timestamptz not null default now() + interval '10 minutes',
  previous_kiosk uuid,
  previous_token_hash text,
  tenant_id uuid,
  device_id uuid,
  court_id uuid,
  target_kiosk uuid,
  target_token_hash text,
  approved_by uuid,
  replacement boolean not null default false,
  decision text not null default 'pending' check (decision in ('pending','approved','declined','enrolled')),
  kiosk_id uuid
);

create table public.tablet_pairing_limits (
  bucket text primary key,
  expires_at timestamptz not null,
  attempts integer not null check (attempts > 0)
);
create index tablet_pairing_request_expiry on public.tablet_pairing_requests(expires_at);
create index tablet_pairing_limit_expiry on public.tablet_pairing_limits(expires_at);
alter table public.tablet_pairing_requests enable row level security;
alter table public.tablet_pairing_limits enable row level security;
revoke all on public.tablet_pairing_requests, public.tablet_pairing_limits from public,anon,authenticated;
grant select,insert,update,delete on public.tablet_pairing_requests, public.tablet_pairing_limits to service_role;

create function public.tablet_pairing_limit(p_bucket text, p_seconds integer, p_max integer)
returns boolean language sql set search_path='' as $$
  with counted as (
    insert into public.tablet_pairing_limits as limits(bucket, expires_at, attempts)
    values (p_bucket, now()+make_interval(secs=>p_seconds), 1)
    on conflict (bucket) do update set
      attempts=case when limits.expires_at<=now() then 1 else limits.attempts+1 end,
      expires_at=case when limits.expires_at<=now() then excluded.expires_at else limits.expires_at end
    where limits.expires_at<=now() or limits.attempts<p_max
    returning 1
  )
  select exists(select 1 from counted);
$$;

create function public.create_tablet_pairing(p_id uuid,p_claim text,p_pin text,p_previous uuid)
returns jsonb language plpgsql set search_path='' as $$
declare pairing public.tablet_pairing_requests;
begin
  delete from public.tablet_pairing_requests where expires_at < now()-interval '7 days';
  delete from public.tablet_pairing_limits where expires_at < now();
  update public.tablet_pairing_requests set pin=null where pin=p_pin and expires_at<=now();
  insert into public.tablet_pairing_requests(id,claim_hash,pin,previous_kiosk,previous_token_hash)
    values(p_id,p_claim,p_pin,p_previous,(select token_hash from public.kiosk_devices where id=p_previous and active)) on conflict (id) do nothing;
  select * into pairing from public.tablet_pairing_requests where id=p_id and claim_hash=p_claim;
  if not found then return null; end if;
  return jsonb_build_object('status',case when pairing.expires_at<=now() then 'expired' else pairing.decision end,
    'pin',case when pairing.expires_at>now() then pairing.pin end,'expiresAt',pairing.expires_at);
end; $$;

create function public.tablet_pairing_admin(p_admin uuid,p_tenant uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists (
    select 1 from public.profiles p where p.id=p_admin and p.active and
    (p.is_super_admin or exists(select 1 from public.tenant_memberships m where
      m.tenant_id=p_tenant and m.user_id=p_admin and m.active and m.role='admin'))
  );
$$;
alter function public.tablet_pairing_admin(uuid,uuid) owner to dinkvision_executor;
revoke all on function public.tablet_pairing_admin(uuid,uuid) from public,anon,authenticated;
grant execute on function public.tablet_pairing_admin(uuid,uuid) to service_role;

create function public.decide_tablet_pairing(
  p_id uuid,p_pin text,p_device uuid,p_court uuid,p_admin uuid,p_tenant uuid,p_replace boolean,p_decline boolean
) returns text language plpgsql set search_path='' as $$
declare pairing public.tablet_pairing_requests; target public.browser_devices; previous_tenant uuid;
begin
  if p_tenant is distinct from public.current_tenant_id() or not public.tablet_pairing_admin(p_admin,p_tenant)
    then return 'forbidden'; end if;
  -- Every unsuccessful lookup for an administrator shares one rolling budget.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('tablet-pair:'||p_admin::text,0));
  if exists(select 1 from public.tablet_pairing_limits where bucket='lookup:'||p_admin::text
    and attempts>=5 and expires_at>now()) then return 'limited'; end if;
  select * into pairing from public.tablet_pairing_requests
    where pin=p_pin and expires_at>now() and (p_id is null or id=p_id) for update;
  if not found then
    perform public.tablet_pairing_limit('lookup:'||p_admin::text,600,5);
    return 'unavailable';
  end if;
  if pairing.previous_kiosk is not null then
    select tenant_id into previous_tenant from public.kiosk_devices where id=pairing.previous_kiosk;
    if previous_tenant is distinct from p_tenant then return 'unavailable'; end if;
  end if;
  if pairing.decision<>'pending' then
    if pairing.approved_by=p_admin and pairing.tenant_id=p_tenant and
       ((pairing.decision='declined' and p_decline) or
        (pairing.decision in ('approved','enrolled') and not p_decline and pairing.device_id=p_device))
    then return pairing.decision; end if;
    return 'unavailable';
  end if;
  if not p_decline then
    select * into target from public.browser_devices where id=p_device and tenant_id=p_tenant and enabled;
    if not found or target.court_id is distinct from p_court or not exists (
      select 1 from public.courts where id=p_court and tenant_id=p_tenant and active
    ) then return 'assignment'; end if;
    if (target.kiosk_id is not null or pairing.previous_kiosk is not null) and not p_replace
      then return 'replacement'; end if;
  end if;
  update public.tablet_pairing_requests set tenant_id=p_tenant,device_id=p_device,court_id=p_court,
    target_kiosk=target.kiosk_id,target_token_hash=(select token_hash from public.kiosk_devices where id=target.kiosk_id),approved_by=p_admin,
    replacement=p_replace,decision=case when p_decline then 'declined' else 'approved' end where id=pairing.id;
  return case when p_decline then 'declined' else 'approved' end;
end; $$;

create function public.claim_tablet_pairing(p_id uuid,p_claim text,p_token text,p_setup text)
returns text language plpgsql set search_path='' as $$
declare pairing public.tablet_pairing_requests; target public.browser_devices; kiosk uuid; headers text;
begin
  select * into pairing from public.tablet_pairing_requests where id=p_id and claim_hash=p_claim for update;
  if not found then return 'unavailable'; end if;
  if pairing.decision='enrolled' then
    if exists(select 1 from public.kiosk_devices k join public.browser_devices d on d.kiosk_id=k.id
       where k.id=pairing.kiosk_id and k.active and k.token_hash=p_token and d.id=pairing.device_id and d.enabled)
    then return 'enrolled'; end if;
    return 'unavailable';
  end if;
  if pairing.expires_at<=now() then return 'expired'; end if;
  if pairing.decision<>'approved' then return pairing.decision; end if;
  select * into target from public.browser_devices where id=pairing.device_id and tenant_id=pairing.tenant_id and enabled for update;
  if not found or target.kiosk_id is distinct from pairing.target_kiosk
    or (select token_hash from public.kiosk_devices where id=target.kiosk_id) is distinct from pairing.target_token_hash
    or target.court_id is distinct from pairing.court_id or not exists (
    select 1 from public.courts where id=target.court_id and tenant_id=pairing.tenant_id and active
  ) then return 'assignment'; end if;
  perform 1 from public.kiosk_devices
    where id in (target.kiosk_id,pairing.previous_kiosk) order by id for update;
  if pairing.previous_kiosk is not null and not exists (
    select 1 from public.kiosk_devices where id=pairing.previous_kiosk and active and tenant_id=pairing.tenant_id and token_hash=pairing.previous_token_hash
  ) then return 'assignment'; end if;
  -- Reuse the atomic enrollment function and its existing ownership/active-capture guards.
  headers := pg_catalog.current_setting('request.headers',true);
  perform pg_catalog.set_config('request.headers',
    (coalesce(nullif(headers,''),'{}')::jsonb || jsonb_build_object('x-dinkvision-tenant-id',pairing.tenant_id))::text,true);
  update public.browser_devices set enrollment_hash=p_claim,enrollment_expires_at=pairing.expires_at
    where id=target.id;
  kiosk := public.enroll_browser(p_claim,p_token,p_setup,pairing.approved_by,pairing.previous_kiosk);
  update public.browser_devices set enrollment_qr_hash=null,enrollment_qr_failures=0 where id=target.id;
  update public.tablet_pairing_requests set decision='enrolled',kiosk_id=kiosk where id=pairing.id;
  insert into public.audit_events(tenant_id,actor_id,action,safe_detail)
    values(pairing.tenant_id,pairing.approved_by,'tablet.pairing_completed',jsonb_build_object('device_id',target.id));
  perform pg_catalog.set_config('request.headers',coalesce(headers,''),true);
  return 'enrolled';
end; $$;

revoke all on function public.tablet_pairing_limit(text,integer,integer),
 public.create_tablet_pairing(uuid,text,text,uuid),
 public.decide_tablet_pairing(uuid,text,uuid,uuid,uuid,uuid,boolean,boolean),
 public.claim_tablet_pairing(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.tablet_pairing_limit(text,integer,integer),
 public.create_tablet_pairing(uuid,text,text,uuid),
 public.decide_tablet_pairing(uuid,text,uuid,uuid,uuid,uuid,boolean,boolean),
 public.claim_tablet_pairing(uuid,text,text,text) to service_role;
