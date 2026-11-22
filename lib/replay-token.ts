import { createHmac, timingSafeEqual } from "node:crypto";

export type ReplayClaims = {v:1;tenant:string;file:string;exp:number};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function signingKey(key:string) {
  const bytes=Buffer.from(key,"base64");
  if(bytes.length!==32) throw new Error("Replay signing is not configured.");
  return bytes;
}
export function signReplay(claims:ReplayClaims,key:string) {
  if(!uuid.test(claims.tenant)||!uuid.test(claims.file)||!Number.isSafeInteger(claims.exp)) throw new Error("Invalid replay identity.");
  const payload=Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${createHmac("sha256",signingKey(key)).update(payload).digest("base64url")}`;
}
export function verifyReplay(token:string,key:string,now=Date.now()):ReplayClaims|null {
  if(token.length>1024) return null;
  const parts=token.split(".");
  if(parts.length!==2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
  const expected=createHmac("sha256",signingKey(key)).update(parts[0]).digest();
  const signature=Buffer.from(parts[1],"base64url");
  if(signature.length!==expected.length || !timingSafeEqual(signature,expected)) return null;
  try {
    const claims=JSON.parse(Buffer.from(parts[0],"base64url").toString("utf8"));
    return claims.v===1 && uuid.test(claims.tenant) && uuid.test(claims.file) && Number.isSafeInteger(claims.exp) && claims.exp>Math.floor(now/1000) ? claims : null;
  } catch {return null;}
}
