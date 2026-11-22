import { getAccount } from "@/lib/auth";
import { serverSupabase } from "@/lib/supabase-server";
import { json } from "@/lib/http";
import { uuid } from "@/lib/validation";
import { driveId } from "@/lib/google-drive";
import { NextResponse } from "next/server";
import { privatePlayback } from "@/lib/replay-server";
export async function GET(_request: Request, context: {params:Promise<{id:string}>}) {
  const {account}=await getAccount();
  if (!account) return json({error:"Please sign in."},401);
  try {
    if (!account.tenantId) return json({error:"Select an authorized tenant."},403);
    const db=await serverSupabase(account.tenantId);
    const file=await db.from("recording_files").select("drive_file_id,storage_provider,storage_bucket,storage_key,expires_at").eq("session_id",uuid((await context.params).id)).eq("status","ready").is("deleted_at",null).gt("expires_at",new Date().toISOString()).single();
    if (file.error || (!file.data.drive_file_id && file.data.storage_provider!=="r2")) return json({error:"Recording is unavailable or its viewing period has ended."},404);
    const destination=file.data.storage_provider==="r2" ? await privatePlayback(file.data,new URL(_request.url).searchParams.get("download")==="1") : `https://drive.google.com/file/d/${driveId(file.data.drive_file_id)}/view`;
    const response=NextResponse.redirect(destination,303);
    response.headers.set("Cache-Control","private, no-store");
    response.headers.set("Referrer-Policy","no-referrer");
    return response;
  } catch { return json({error:"Recording is unavailable."},404); }
}
