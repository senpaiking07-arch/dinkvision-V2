import "server-only";
import { createHmac } from "node:crypto";
import { systemDatabase } from "./recorder-server";

export const pairingSecret = /^[A-Za-z0-9_-]{43}$/;
export const pairingPage = "/admin/pair-device";

export function pairingKey(purpose: string, value: string) {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("Pairing service unavailable.");
  return createHmac("sha256", key).update(`tablet-pairing:${purpose}:${value}`).digest("base64url");
}

export async function pairingLimit(request: Request, action: string, max: number, identity?: string) {
  // Vercel supplies this edge header. Other deployments share a conservative fallback bucket.
  const ip = request.headers.get("x-vercel-forwarded-for")?.split(",")[0].trim() || "unknown";
  const keys = [`ip:${ip}`, ...(identity ? [`identity:${identity}`] : [])];
  const db = systemDatabase();
  for (const key of keys) {
    const result = await db.rpc("tablet_pairing_limit", {
      p_bucket: pairingKey(action, key), p_seconds: 60, p_max: max,
    });
    if (result.error) throw result.error;
    if (result.data !== true) return false;
  }
  return true;
}
