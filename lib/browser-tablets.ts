import "server-only";
import { cookies } from "next/headers";
import { kioskDevice, hashKiosk } from "./kiosk";
import { recorderDatabase } from "./recorder-server";
import { getAccount } from "./auth";

export async function browserTablet() {
  const kiosk = await kioskDevice();
  if (!kiosk) return null;
  const { data, error } = await recorderDatabase(kiosk.tenant_id)
    .from("browser_devices")
    .select("*")
    .eq("kiosk_id", kiosk.id)
    .eq("enabled", true)
    .maybeSingle();
  if (error) throw error;
  return data ? { device: data, kiosk } : null;
}
export async function canSetup(device: {
  tenant_id?: string;
  setup_hash: string | null;
  setup_expires_at: string | null;
}) {
  const secret = (await cookies()).get("cb-tablet-setup")?.value;
  if (
    secret &&
    device.setup_hash === hashKiosk(secret) &&
    Date.parse(device.setup_expires_at || "") > Date.now()
  )
    return true;
  const account = (await getAccount()).account;
  return account?.role === "admin" && !!device.tenant_id && account.tenantId === device.tenant_id;
}
export function publicTablet(d: Record<string, any>) {
  const {
    enrollment_hash,
    consumed_enrollment_hash,
    enrollment_qr_hash,
    enrollment_qr_failures,
    setup_hash,
    rtsp_url,
    rtsp_username,
    rtsp_password_encrypted,
    ...safe
  } = d;
  return safe;
}
