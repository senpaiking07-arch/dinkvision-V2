import { NextResponse } from "next/server";
import { guestReplay,privatePlayback } from "@/lib/replay-server";
import { json } from "@/lib/http";
export async function GET(request:Request,context:{params:Promise<{token:string}>}) {
  try {
    const download = new URL(request.url).searchParams.get("download") === "1";
    const file=await guestReplay((await context.params).token, download);
    if(!file) return json({error:"This replay link is unavailable or expired."},404);
    const response=NextResponse.redirect(await privatePlayback(file,download),307);
    response.headers.set("Cache-Control","private, no-store");
    response.headers.set("Referrer-Policy","no-referrer");
    response.headers.set("X-Robots-Tag","noindex, nofollow");
    return response;
  } catch {return json({error:"Replay is temporarily unavailable. Please retry."},503);}
}
