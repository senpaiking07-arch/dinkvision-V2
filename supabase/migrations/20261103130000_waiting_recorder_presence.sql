-- Waiting local work is not a failed transfer. Only the owning authenticated
-- device's queue-presence endpoint refreshes last_seen_at for retained files.
-- Actual uploading claims still expire on transfer activity, not app presence.
create or replace function public.expire_browser_uploads(p_device uuid default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  update public.browser_recordings b set upload_state='failed',lease_until=null,
    lease_token=null,upload_updated_at=now(),
    last_error='Upload connection expired. Local footage is retained for recovery.',
    safe_error='Upload connection expired. Local footage is retained for recovery.'
  where (p_device is null or b.device_id=p_device)
    and b.upload_state in ('pending','queued','retrying','uploading')
    and coalesce(b.upload_updated_at,b.upload_queued_at,b.last_seen_at)<now()-interval '3 minutes'
    and (b.upload_state='uploading' or b.last_seen_at is null or b.last_seen_at<now()-interval '3 minutes')
    and (b.lease_until is null or b.lease_until<now())
    and exists(select 1 from public.recording_sessions s where s.id=b.session_id and s.status in ('uploading','sharing'));
end; $$;

alter function public.expire_browser_uploads(uuid) owner to dinkvision_executor;
revoke all on function public.expire_browser_uploads(uuid) from public,anon,authenticated;
grant execute on function public.expire_browser_uploads(uuid) to service_role;
