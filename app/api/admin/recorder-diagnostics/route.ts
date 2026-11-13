import { cookies } from "next/headers";
import { TENANT_COOKIE } from "@/lib/tenant-scope";
import { getAccount } from "@/lib/auth";
import { serverSupabase } from "@/lib/supabase-server";
import { json } from "@/lib/http";
import { InputError, uuid } from "@/lib/validation";

export async function GET(request:Request) {
  if (!(await getAccount()).account) return json({error:"Admin sign-in required."},403);
  if (process.env.RECORDER_DIAGNOSTICS_ENABLED!=="true") return json({enabled:false,events:[]});
  try {
    const params=new URL(request.url).searchParams;
    const session=params.get("session"),device=params.get("device");
    if (!!session===!!device) throw new InputError("Choose a recording or device.");
    // Use the signed-in user's RLS scope, never service-role visibility.
    const selectedTenant = (await cookies()).get(TENANT_COOKIE)?.value;
    const db = await serverSupabase(selectedTenant ? uuid(selectedTenant) : undefined);
    const admin = await db.rpc("is_admin");
    if (admin.error) throw admin.error;
    if (admin.data !== true) return json({error:"Tenant administrator required."},403);
    let query=db.from("recorder_diagnostics").select("*");
    if (session) query=query.eq("session_id",uuid(session));
    else query=query.eq("device_id",uuid(device));
    let {data,error}=await query.order("received_at",{ascending:false}).limit(150);
    if (error) throw error;
    if (session && data?.length) {
      // Include preparation events emitted before the server assigned a session ID.
      const attempts=[...new Set(data.map(row=>uuid(row.attempt_id)))];
      const related=await db.from("recorder_diagnostics").select("*")
        .eq("device_id",data[0].device_id).in("attempt_id",attempts)
        .order("received_at",{ascending:false}).limit(150);
      if (related.error) throw related.error;
      data=related.data;
    }
    return json({enabled:true,events:data||[]});
  } catch (error) {
    return json({error:error instanceof InputError?error.message:"Diagnostic history is unavailable."},
      error instanceof InputError?400:503);
  }
}
