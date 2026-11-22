import "server-only";
import { r2Store, usesR2 } from "./r2-server";
import { checkDriveHealth } from "./google-server";

let cached:{ready:boolean;code:string;checkedAt:string}|undefined;
export async function storageHealth(force=false) {
  if(!usesR2()) return checkDriveHealth(force);
  if(!force && cached && Date.now()-Date.parse(cached.checkedAt)<30000) return cached;
  try {
    await r2Store().healthy();
    return cached={ready:true,code:"connected",checkedAt:new Date().toISOString()};
  } catch { return cached={ready:false,code:"r2_unavailable",checkedAt:new Date().toISOString()}; }
}
