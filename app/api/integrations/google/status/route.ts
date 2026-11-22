import { getAccount } from "@/lib/auth";
import { json } from "@/lib/http";
import { recorderDatabase } from "@/lib/recorder-server";
import { googleConfig, driveMessages } from "@/lib/google-server";
import { gmailConfig } from "@/lib/gmail-server";
import { usesR2 } from "@/lib/r2-server";
import { storageHealth } from "@/lib/storage-health";
export async function GET() {
  const {account}=await getAccount();
  if (account?.role!=="admin" || !account.tenantId) return json({error:"Administrator access required."},403);
  if (usesR2()) {
    let configured=true,redirect="";
    try {redirect=(await gmailConfig(account.tenantId)).redirect;} catch {configured=false;}
    const integration=await recorderDatabase(account.tenantId).from("gmail_integrations").select("owner_email,connected_at,safe_error").maybeSingle();
    if(integration.error) return json({error:"Email status is unavailable."},503);
    return json({provider:"r2",configured,redirect,integration:integration.data,storage:await storageHealth(),jobs:[]});
  }
  let configured=true,redirect="";
  try { redirect=googleConfig().redirect; } catch { configured=false; }
  const db=recorderDatabase(account.tenantId);
  const [integration,jobs]=await Promise.all([
    db.from("google_integration").select("owner_email,root_folder_id,connected_at,safe_error").eq("id",true).maybeSingle(),
    db.from("drive_upload_jobs").select("file_id,status,attempts,safe_error,next_attempt_at,recording_files(session_id,status)").order("created_at",{ascending:false}).limit(50),
  ]);
  if (integration.error || jobs.error) return json({error:"Drive database setup is unavailable."},503);
  return json({configured,redirect,integration:integration.data,jobs:(jobs.data || []).map(j=>({...j,message:j.safe_error ? driveMessages[j.safe_error] || "Upload paused. Retry or ask the administrator to check Google access." : null}))});
}
