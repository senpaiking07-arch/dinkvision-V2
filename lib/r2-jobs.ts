import "server-only";
import { randomUUID } from "node:crypto";
import { recorderDatabase, systemDatabase } from "./recorder-server";
import { r2Store } from "./r2-server";
import { r2Upload } from "./r2-upload";
import { confirmedParts } from "./r2-protocol";
import { deliverNextEmail } from "./email-server";

async function runTenant(tenant:string,deadline:number) {
  const db=recorderDatabase(tenant),store=r2Store();
  const pending=await db.from("r2_upload_attempts").select("*").eq("state","uploading")
    .order("updated_at").limit(2);
  if(pending.error) throw pending.error;
  for(const row of pending.data) {
    if(Date.now()>deadline) return;
    if(row.device_id) try {
      // Observing a partial upload must not refresh its client heartbeat or
      // attempt timestamp; otherwise abandoned uploads would never expire.
      const head=await store.head(row);
      if(!head && !confirmedParts(await store.parts(row),Number(row.bytes),Number(row.part_size||8388608)).uploaded) continue;
      if(Date.now()>deadline) return;
      await r2Upload(row.session_id,row.device_id,tenant,"finish",{attempt_id:row.id});
    }
    catch { /* Still transferring, waiting for its turn, or already paused. */ }
  }
  if(Date.now()>deadline) return;
  await deliverNextEmail(undefined,undefined,tenant);
  const expired=await db.from("recording_files").select("id,session_id,storage_bucket,storage_key,expires_at")
    .eq("storage_provider","r2").in("status",["ready","deleting"]).is("deleted_at",null)
    .lte("expires_at",new Date().toISOString()).order("expires_at").limit(3);
  if(expired.error) throw expired.error;
  for(const file of expired.data) {
    if(Date.now()>deadline) return;
    const lease=randomUUID();
    const claim=await db.from("browser_recordings").update({lease_token:lease,lease_until:new Date(Date.now()+90000).toISOString()})
      .eq("file_id",file.id).or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`).select("session_id").maybeSingle();
    if(claim.error) throw claim.error;
    if(!claim.data) continue;
    try {
      const object={bucket:file.storage_bucket,object_key:file.storage_key,upload_id:null};
      const head=await store.head(object);
      if(head && (head.Metadata?.tenant!==tenant || head.Metadata?.session!==file.session_id)) throw new Error("Storage identity mismatch.");
      const marking=await db.from("recording_files").update({status:"deleting"}).eq("id",file.id)
        .in("status",["ready","deleting"]).lte("expires_at",new Date().toISOString()).select("id").maybeSingle();
      if(marking.error || !marking.data) throw new Error("Recording retention changed.");
      await store.remove(object);
      const deleted=await db.rpc("finish_r2_cleanup",{p_file:file.id,p_lease:lease});
      if(deleted.error || !deleted.data) throw new Error("Cleanup confirmation is pending.");
    } catch {
      await db.from("browser_recordings").update({safe_error:"Expired cloud video cleanup will retry."}).eq("file_id",file.id);
    } finally {
      await db.from("browser_recordings").update({lease_until:null}).eq("file_id",file.id).eq("lease_token",lease);
    }
  }
  const cutoff=new Date(Date.now()-24*3600000).toISOString();
  const abandoned=await db.from("r2_upload_attempts").select("*")
    .or(`state.eq.aborting,and(state.in.(creating,uploading),updated_at.lt.${cutoff})`).order("updated_at").limit(3);
  if(abandoned.error) throw abandoned.error;
  for(const attempt of abandoned.data) {
    if(Date.now()>deadline) return;
    const lease=randomUUID();
    const claim=await db.from("browser_recordings").update({lease_token:lease,lease_until:new Date(Date.now()+90000).toISOString()})
      .eq("session_id",attempt.session_id).or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`)
      .select("session_id").maybeSingle();
    if(claim.error || !claim.data) continue;
    try {
      const claimed=await db.from("r2_upload_attempts").update({state:"aborting",updated_at:new Date().toISOString()})
        .eq("id",attempt.id).eq("state",attempt.state).eq("updated_at",attempt.updated_at).select("id").maybeSingle();
      if(claimed.error) throw claimed.error;
      if(!claimed.data) continue;
      const referenced=await db.from("recording_files").select("id").eq("storage_bucket",attempt.bucket)
        .eq("storage_key",attempt.object_key).in("status",["ready","deleting"]).maybeSingle();
      if(referenced.error || referenced.data) throw new Error("Completed recording must be retained.");
      await store.abort(attempt);
      const head=await store.head(attempt);
      if(head) {
        if(head.Metadata?.tenant!==tenant || head.Metadata?.attempt!==attempt.id) throw new Error("Storage identity mismatch.");
        await store.remove(attempt);
      }
      const aborted=await db.from("r2_upload_attempts").update({state:"aborted",updated_at:new Date().toISOString()}).eq("id",attempt.id).eq("state","aborting");
      if(aborted.error) throw aborted.error;
    } catch { /* Durable aborting rows retry on the next worker run. */ }
    finally {await db.from("browser_recordings").update({lease_until:null}).eq("session_id",attempt.session_id).eq("lease_token",lease);}
  }
  const health=await db.from("venue_settings").update({browser_worker_at:new Date().toISOString()}).eq("id",true);
  if(health.error) throw health.error;
}

export async function runR2Jobs(tenant?:string) {
  const deadline=Date.now()+40000;
  // Rotate tenants by their last worker attempt so a large tenant cannot starve others.
  const settings=tenant ? {data:[{tenant_id:tenant}],error:null} : await systemDatabase().from("venue_settings").select("tenant_id")
    .order("browser_worker_attempt_at",{nullsFirst:true}).limit(5);
  if(settings.error) throw settings.error;
  let completed=0;
  for(const row of settings.data) {
    if(Date.now()>deadline) break;
    const db=recorderDatabase(row.tenant_id);
    await db.from("venue_settings").update({browser_worker_attempt_at:new Date().toISOString()}).eq("id",true);
    await runTenant(row.tenant_id,deadline);
    completed++;
  }
  return {ok:true,tenants:completed};
}
