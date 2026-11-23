import "server-only";
import { r2Store, usesR2 } from "./r2-server";

let cached: { ready: boolean; code: string; checkedAt: string } | undefined;
export async function storageHealth(force = false) {
  if (!usesR2()) return { ready: false, code: "r2_not_configured", checkedAt: new Date().toISOString() };
  if (!force && cached && Date.now() - Date.parse(cached.checkedAt) < 30000) return cached;
  let storage: ReturnType<typeof r2Store>;
  try {
    storage = r2Store();
  } catch {
    return { ready: false, code: "r2_not_configured", checkedAt: new Date().toISOString() };
  }
  try {
    await storage.healthy();
    return cached = { ready: true, code: "connected", checkedAt: new Date().toISOString() };
  } catch {
    return cached = { ready: false, code: "r2_unavailable", checkedAt: new Date().toISOString() };
  }
}
