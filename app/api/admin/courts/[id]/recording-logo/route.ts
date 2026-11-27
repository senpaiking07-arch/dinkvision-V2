import { randomUUID } from "node:crypto";
import { getAccount } from "@/lib/auth";
import { courtLogoResponse, normalizeCourtLogo } from "@/lib/court-logo";
import { json, sameOrigin } from "@/lib/http";
import { recorderDatabase } from "@/lib/recorder-server";
import { InputError, uuid } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

async function handle(request: Request, { params }: Context) {
  if (request.method !== "GET" && !sameOrigin(request))
    return json({ error: "Invalid request origin." }, 403);
  try {
    const { account } = await getAccount();
    if (account?.role !== "admin" || !account.tenantId)
      return json({ error: "Admin sign-in required." }, 403);
    const court = uuid((await params).id);
    const db = recorderDatabase(account.tenantId);
    const found = await db.from("courts").select("id").eq("id", court).maybeSingle();
    if (found.error) throw found.error;
    if (!found.data) return json({ error: "Court not found." }, 404);
    const logos = db.from("court_recording_logos");
    if (request.method === "GET") {
      const { data, error } = await logos.select("png").eq("court_id", court).maybeSingle();
      if (error) throw error;
      return data ? courtLogoResponse(data.png) : new Response(null, {
        status: 204, headers: { "Cache-Control": "private, no-store" },
      });
    }
    if (request.method === "DELETE") {
      const { error } = await logos.delete().eq("court_id", court);
      if (error) throw error;
      return json({ ok: true });
    }
    const png = await normalizeCourtLogo(request);
    const { error } = await logos.upsert({
      court_id: court, version: randomUUID(), png: "\\x" + png.toString("hex"),
    }, { onConflict: "tenant_id,court_id" });
    if (error) throw error;
    return courtLogoResponse(png);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, 400);
    return json({ error: "The recording logo service is temporarily unavailable." }, 503);
  }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
