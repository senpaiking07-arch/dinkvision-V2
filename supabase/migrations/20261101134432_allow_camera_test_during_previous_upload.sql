-- Camera confirmation belongs to the capture workflow. A previously saved
-- match can keep uploading while the tablet checks its camera for the next one.
create or replace function public.native_camera_test(
  p_kiosk uuid, p_revision uuid, p_passed boolean
) returns boolean
language plpgsql security definer set search_path='' as $$
declare d public.browser_devices;
begin
  select * into d from public.browser_devices
  where kiosk_id=p_kiosk and enabled for update;
  if not found or d.recorder_mode<>'android_rtsp' or d.config_revision<>p_revision then
    return false;
  end if;
  if not exists(select 1 from public.kiosk_devices where id=p_kiosk and active) then
    return false;
  end if;
  if exists(
    select 1 from public.browser_recordings b
    join public.recording_sessions s on s.id=b.session_id
    where b.device_id=d.id
      and s.status in ('requested','starting','recording','finalizing')
  ) then
    return false;
  end if;
  update public.browser_devices
  set tested_at=case when p_passed then now() else null end,
      tested_revision=case when p_passed then p_revision else null end,
      test_requested=false,
      diagnostic=case when p_passed then 'Video/audio recording test passed.'
        else 'Camera test failed. Check camera settings and tablet Wi-Fi, then retry.' end
  where id=d.id;
  return true;
end; $$;

revoke all on function public.native_camera_test(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.native_camera_test(uuid,uuid,boolean) to service_role;
