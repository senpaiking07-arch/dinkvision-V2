-- Optional, client-reported hardware details. They do not establish camera health.
alter table public.browser_devices add column if not exists device_info jsonb
  check (device_info is null or
    (jsonb_typeof(device_info)='object' and octet_length(device_info::text)<=4096));
