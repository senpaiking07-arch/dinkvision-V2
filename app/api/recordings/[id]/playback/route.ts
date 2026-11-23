import { getAccount } from "@/lib/auth";
import { serverSupabase } from "@/lib/supabase-server";
import { json } from "@/lib/http";
import { uuid } from "@/lib/validation";
import { NextResponse } from "next/server";
import { privatePlayback, replayDownloadFields, replayStorageFields } from "@/lib/replay-server";
export async function GET(request: Request, context: {params:Promise<{id:string}>}) {
  const {account}=await getAccount();
  if (!account) return json({error:"Please sign in."},401);
  try {
    if (!account.tenantId) return json({error:"Select an authorized tenant."},403);
    const download = new URL(request.url).searchParams.get("download") === "1";
    const db=await serverSupabase(account.tenantId);
    const files = db.from("recording_files");
    const query = download ? files.select(replayDownloadFields) : files.select(replayStorageFields);
    const file=await query.eq("session_id",uuid((await context.params).id)).eq("status","ready").is("deleted_at",null).gt("expires_at",new Date().toISOString()).single();
    if (file.error || file.data.storage_provider!=="r2") return json({error:"Recording is unavailable or its viewing period has ended."},404);
    const destination=await privatePlayback(file.data,download);
    const response=NextResponse.redirect(destination,303);
    response.headers.set("Cache-Control","private, no-store");
    response.headers.set("Referrer-Policy","no-referrer");
    return response;
  } catch { return json({error:"Recording is unavailable."},404); }
}
