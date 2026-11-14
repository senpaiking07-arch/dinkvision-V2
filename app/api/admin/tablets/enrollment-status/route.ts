import { cookies } from "next/headers";
import { getAccount } from "@/lib/auth";
import { json, readBody, sameOrigin } from "@/lib/http";
import { hashKiosk } from "@/lib/kiosk";
import { recorderDatabase } from "@/lib/recorder-server";
import { serverSupabase } from "@/lib/supabase-server";
import { pairingCode } from "@/lib/tablet-enrollment";
import { DEFAULT_TENANT_ID, TENANT_COOKIE } from "@/lib/tenant-scope";
import { InputError, uuid } from "@/lib/validation";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Invalid origin." }, 403);
  try {
    if ((await getAccount()).account?.role !== "admin")
      return json({ error: "Admin sign-in required." }, 403);

    const { id, code } = await readBody(request);
    const deviceId = uuid(id);
    if (typeof code !== "string" || !pairingCode.test(code))
      throw new InputError("Invalid enrollment invitation.");

    const selected = (await cookies()).get(TENANT_COOKIE)?.value;
    const tenant = selected ? uuid(selected) : DEFAULT_TENANT_ID;
    const authorization = await (await serverSupabase(tenant)).rpc("is_admin");
    if (authorization.error) throw authorization.error;
    if (authorization.data !== true) return json({ error: "Venue administrator required." }, 403);

    const { data, error } = await recorderDatabase(tenant)
      .from("browser_devices")
      .select("enabled,enrollment_hash,enrollment_expires_at,consumed_enrollment_hash")
      .eq("id", deviceId)
      .maybeSingle();
    if (error) throw error;

    const hash = hashKiosk(code);
    if (data?.enabled && data.consumed_enrollment_hash === hash)
      return json({ status: "paired" });
    if (data?.enabled && data.enrollment_hash === hash && Date.parse(data.enrollment_expires_at || "") > Date.now())
      return json({ status: "pending" });
    return json({ status: "unavailable" });
  } catch (error) {
    return error instanceof InputError
      ? json({ error: error.message }, 400)
      : json({ error: "Pairing status is temporarily unavailable." }, 503);
  }
}
