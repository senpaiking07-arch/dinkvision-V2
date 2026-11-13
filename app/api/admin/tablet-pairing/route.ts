import { cookies } from "next/headers";
import { getAccount } from "@/lib/auth";
import { json, readBody, sameOrigin } from "@/lib/http";
import { recorderDatabase } from "@/lib/recorder-server";
import { serverSupabase } from "@/lib/supabase-server";
import { DEFAULT_TENANT_ID, TENANT_COOKIE } from "@/lib/tenant-scope";
import { enrollmentPin } from "@/lib/tablet-enrollment";
import { pairingLimit } from "@/lib/tablet-pairing";
import { InputError, uuid } from "@/lib/validation";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Invalid origin." }, 403);
  try {
    const { account } = await getAccount();
    if (account?.role !== "admin") return json({ error: "Administrator sign-in required." }, 403);
    const selected = (await cookies()).get(TENANT_COOKIE)?.value;
    const tenant = selected ? uuid(selected) : DEFAULT_TENANT_ID;
    const authorization = await (await serverSupabase(tenant)).rpc("is_admin");
    if (authorization.error) throw authorization.error;
    if (authorization.data !== true) return json({ error: "Venue administrator required." }, 403);
    const body = await readBody(request);
    if (typeof body.pin !== "string" || !enrollmentPin.test(body.pin))
      throw new InputError("Enter the six digits shown on the tablet.");
    if (body.action !== "approve" && body.action !== "decline") throw new InputError("Choose approve or decline.");
    if (!await pairingLimit(request, "decision", 25, account.id))
      return json({ error: "Too many pairing attempts. Try again later." }, 429);
    const decline = body.action === "decline";
    const result = await recorderDatabase(tenant).rpc("decide_tablet_pairing", {
      p_id: body.request ? uuid(body.request) : null, p_pin: body.pin,
      p_device: decline ? null : uuid(body.device), p_court: decline ? null : uuid(body.court),
      p_admin: account.id, p_tenant: tenant, p_replace: body.replace === true, p_decline: decline,
    });
    if (result.error) throw result.error;
    switch (result.data) {
      case "approved": case "declined": case "enrolled": return json({ status: result.data });
      case "forbidden": return json({ error: "Venue administrator required." }, 403);
      case "limited": return json({ error: "Five unsuccessful lookups. Try again after the ten-minute window." }, 429);
      case "assignment": return json({ error: "Select an enabled device assigned to an active court in this venue." }, 409);
      case "replacement": return json({ error: "Confirm replacement before approving the request.", replacementRequired: true }, 409);
      default: return json({ error: "No active matching request. Check the tablet’s number." }, 404);
    }
  } catch (error) {
    return json({ error: error instanceof InputError ? error.message : "Pairing approval is unavailable. Try again." },
      error instanceof InputError ? 400 : 503);
  }
}
