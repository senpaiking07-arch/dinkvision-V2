alter table public.browser_devices
  add column enrollment_qr_hash text unique,
  add column enrollment_qr_failures smallint not null default 0
    check (enrollment_qr_failures between 0 and 5);

-- Each attempt holds the invitation row lock, including an invalid PIN.
-- A wrong PIN must return normally so the failure count commits.
create function public.enroll_browser_qr(
  p_invite text, p_hash text, p_token text, p_setup text, p_admin uuid, p_previous_kiosk uuid
) returns uuid language plpgsql security definer set search_path='' as $$
declare device public.browser_devices; kiosk uuid;
begin
  select * into device from public.browser_devices
    where enrollment_qr_hash=p_invite and enrollment_expires_at>now() and enabled for update;
  if not found or device.enrollment_qr_failures>=5 then return null; end if;
  if device.enrollment_hash is distinct from p_hash then
    update public.browser_devices set enrollment_qr_failures=enrollment_qr_failures+1 where id=device.id;
    return null;
  end if;
  kiosk := public.enroll_browser(p_hash,p_token,p_setup,p_admin,p_previous_kiosk);
  update public.browser_devices set enrollment_qr_hash=null,enrollment_qr_failures=0 where id=device.id;
  return kiosk;
end; $$;
alter function public.enroll_browser_qr(text,text,text,text,uuid,uuid) owner to dinkvision_executor;
revoke all on function public.enroll_browser_qr(text,text,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.enroll_browser_qr(text,text,text,text,uuid,uuid) to service_role;
