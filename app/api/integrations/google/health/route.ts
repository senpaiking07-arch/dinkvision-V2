import { getAccount } from "@/lib/auth";
import { json, sameOrigin } from "@/lib/http";
import { checkDriveHealth, driveMessages, googleConfig } from "@/lib/google-server";
import { usesR2 } from "@/lib/r2-server";
import { storageHealth } from "@/lib/storage-health";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({error:"Invalid origin."},403);
  const {account} = await getAccount();
  if (account?.role !== "admin") return json({error:"Administrator access required."},403);
  if (usesR2()) {
    const health=await storageHealth(true);
    return json({...health,provider:"r2",redirect:"",message:health.ready ? "Private R2 storage is connected." : "R2 storage is unavailable. Check the server credentials and bucket access."});
  }
  const health = await checkDriveHealth(true);
  let redirect = "";
  try { redirect = googleConfig().redirect; } catch { /* reported by health */ }
  return json({...health,redirect,message:health.ready ? "Google Drive connected. Folder access checked." : driveMessages[health.code] || "Google Drive could not be checked. Retry before starting a recording."});
}
