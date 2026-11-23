import { getAccount } from "@/lib/auth";
import { serverSupabase } from "@/lib/supabase-server";
import { json } from "@/lib/http";
import { uuid } from "@/lib/validation";
import { NextResponse } from "next/server";
import { checkReplayStorage, privatePlayback, ReplayObjectMissing, replayDownloadFields, replayStorageFields } from "@/lib/replay-server";
export async function GET(request: Request, context: {params:Promise<{id:string}>}) {
  const {account}=await getAccount();
  if (!account) return json({error:"Please sign in."},401);
  try {
    if (!account.tenantId) return json({error:"Select an authorized tenant."},403);
    const search = new URL(request.url).searchParams;
    const check = search.get("check") === "1";
    const download = !check && search.get("download") === "1";
    let sessionId: string;
    try { sessionId = uuid((await context.params).id); }
    catch { return json({error:"Invalid recording ID."},400); }
    const db=await serverSupabase(account.tenantId);
    const files = db.from("recording_files");
    const query = download ? files.select(replayDownloadFields) : files.select(replayStorageFields);
    const file=await query.eq("session_id",sessionId).eq("storage_provider","r2").eq("status","ready").is("deleted_at",null).gt("expires_at",new Date().toISOString()).maybeSingle();
    if (file.error) throw file.error;
    if (!file.data) return json({error:"Recording is unavailable or its viewing period has ended."},404);
    if (check) {
      await checkReplayStorage(file.data);
      return json({available:true},200);
    }
    const destination=await privatePlayback(file.data,download);
    const response=NextResponse.redirect(destination,303);
    response.headers.set("Cache-Control","private, no-store");
    response.headers.set("Referrer-Policy","no-referrer");
    return response;
  } catch (error) {
    if (error instanceof ReplayObjectMissing) return json({code:"recording_file_missing",error:"File missing from storage."},404);
    return json({error:"Recording storage is temporarily unavailable. Please retry."},503);
  }
}
