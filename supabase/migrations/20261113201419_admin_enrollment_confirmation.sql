-- Record the consumed invitation in the same update that registers the device.
-- Retain only the last consumed hash. It is never returned in device payloads.
alter table public.browser_devices add column consumed_enrollment_hash text;

create function public.remember_consumed_browser_enrollment()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.consumed_enrollment_hash := old.enrollment_hash;
  return new;
end;
$$;

create trigger remember_consumed_browser_enrollment
before update of enrollment_hash on public.browser_devices
for each row when (
  old.enrollment_hash is not null
  and new.enrollment_hash is null
  and new.enrollment_expires_at is null
  and new.kiosk_id is not null
  and new.enabled
  and new.setup_hash is not null
  and new.setup_hash is distinct from old.setup_hash
)
execute function public.remember_consumed_browser_enrollment();

revoke all on function public.remember_consumed_browser_enrollment() from public, anon, authenticated;
