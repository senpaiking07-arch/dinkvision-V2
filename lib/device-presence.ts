export function devicePresence(device: {enabled?: boolean;kiosk_id?: string|null;last_seen_at?: string|null}, now: number) {
  if (!device.enabled) return {connected:false,label:"Disabled"};
  if (!device.kiosk_id) return {connected:false,label:"Awaiting enrollment"};
  const seen=Date.parse(device.last_seen_at||"");
  if (!Number.isFinite(seen)||seen>now+30000) return {connected:false,label:"Contact unconfirmed"};
  const age=Math.max(0,now-seen);
  return age<=45000 ? {connected:true,label:"Connected"}
    : {connected:false,label:age<=120000?"Contact delayed":"No recent contact"};
}
