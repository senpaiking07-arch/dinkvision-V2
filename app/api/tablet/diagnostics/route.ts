import { browserTablet } from "@/lib/browser-tablets";
import { recorderDatabase } from "@/lib/recorder-server";
import { json, readBody, sameOrigin } from "@/lib/http";
import { InputError, uuid } from "@/lib/validation";
import { parseRecorderEvents } from "@/lib/recorder-events";

export async function POST(request:Request) {
  if (!sameOrigin(request)) return json({error:"Invalid origin."},403);
  if (process.env.RECORDER_DIAGNOSTICS_ENABLED!=="true") return json({error:"Diagnostics are not enabled."},503);
  try {
    const tablet=await browserTablet();
    if (!tablet) return json({error:"Device registration required."},401);
    const body = await readBody(request, 16384);
    const device = tablet.device.id;
    if (uuid(body.device_id).toLowerCase() !== device)
      return json({ error: "Device registration changed. Keep the diagnostic batch on the original device." }, 409);
    const events = parseRecorderEvents(body.events);
    const tenant = tablet.kiosk.tenant_id;
    const db = recorderDatabase(tenant);
    const sessions=[...new Set(events.map(e=>e.session_id).filter((id):id is string=>!!id))];
    let allowed=new Set<string>();
    if (sessions.length) {
      const owned=await db.from("browser_recordings").select("session_id").eq("device_id",device).in("session_id",sessions);
      if (owned.error) throw owned.error;
      allowed=new Set((owned.data||[]).map(row=>row.session_id));
    }
    // A removed recording must not poison delivery of unrelated later events.
    // Return only the submitted event IDs, never information about another owner.
    const accepted=events.filter(e=>!e.session_id || allowed.has(e.session_id));
    const rejected=events.filter(e=>e.session_id && !allowed.has(e.session_id)).map(e=>e.event_id);
    if (!accepted.length) return json({accepted:[],rejected});
    // Immutable event IDs make interrupted delivery safe to retry.
    const saved=await db.from("recorder_diagnostics").upsert(accepted.map(e=>({...e,tenant_id:tenant,device_id:device})),
      {onConflict:"tenant_id,device_id,event_id",ignoreDuplicates:true});
    if (saved.error) throw saved.error;
    return json({accepted:accepted.map(e=>e.event_id),rejected});
  } catch (error) {
    if (error instanceof InputError) return json({error:error.message},400);
    return json({error:"Diagnostics could not be saved. Recording is unaffected."},503);
  }
}
