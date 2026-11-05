-- Keep one active Admin device per app registration. The previous kiosk comes
-- only from the authenticated cookie; the client never supplies its ID.
create function public.enroll_browser(p_hash text,p_token text,p_setup text,p_admin uuid,p_previous_kiosk uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare target public.browser_devices; previous public.browser_devices; k uuid;
begin
  select * into target from public.browser_devices where enrollment_hash=p_hash
    and enrollment_expires_at>now() and enabled for update;
  if not found then raise exception 'Enrollment code is invalid or expired'; end if;
  if p_previous_kiosk is not null then
    select * into previous from public.browser_devices where kiosk_id=p_previous_kiosk for update;
    if found and previous.tenant_id<>target.tenant_id then
      raise exception 'Enroll devices within the same venue';
    end if;
    if found and previous.id<>target.id and exists (
      select 1 from public.browser_recordings b join public.recording_sessions s on s.id=b.session_id
      where b.device_id=previous.id and (s.status in ('requested','starting','recording','finalizing')
        or (b.local_available and b.upload_state not in ('completed','cancelled','discarded')))
    ) then raise exception 'Upload or save the previous device videos before changing registrations'; end if;
  end if;
  k := public.enroll_browser(p_hash,p_token,p_setup,p_admin);
  -- Rotating the same registration reuses its kiosk and must leave it active.
  if p_previous_kiosk is not null and p_previous_kiosk<>k then
    update public.kiosk_devices set active=false where id=p_previous_kiosk;
    update public.browser_devices set enabled=false,tested_at=null,setup_hash=null,setup_expires_at=null
      where kiosk_id=p_previous_kiosk;
  end if;
  return k;
end; $$;
alter function public.enroll_browser(text,text,text,uuid,uuid) owner to dinkvision_executor;
revoke all on function public.enroll_browser(text,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.enroll_browser(text,text,text,uuid,uuid) to service_role;
