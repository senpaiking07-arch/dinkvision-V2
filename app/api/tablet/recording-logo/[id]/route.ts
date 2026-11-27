import { browserTablet } from "@/lib/browser-tablets";
import { courtLogoResponse } from "@/lib/court-logo";
import { json } from "@/lib/http";
import { recorderDatabase } from "@/lib/recorder-server";
import { InputError, uuid } from "@/lib/validation";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const tablet = await browserTablet();
    if (!tablet) return json({ error: "Recorder sign-in required." }, 401);
    const sessionId = uuid((await params).id);
    const db = recorderDatabase(tablet.kiosk.tenant_id);
    const { data: session, error } = await db.from("recording_sessions")
      .select("court_id,configuration_snapshot").eq("id", sessionId).eq("kiosk_id", tablet.kiosk.id).maybeSingle();
    if (error) throw error;
    if (!session || session.configuration_snapshot?.device_id !== tablet.device.id)
      return json({ error: "Recording not found." }, 404);
    const version = session.configuration_snapshot.court_logo_version;
    if (!version) return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
    const { data, error: logoError } = await db.from("court_recording_logos")
      .select("png").eq("court_id", session.court_id).eq("version", version).maybeSingle();
    if (logoError) throw logoError;
    return data ? courtLogoResponse(data.png) : json({ error: "The reserved recording logo is unavailable." }, 404);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, 400);
    return json({ error: "The recording logo service is temporarily unavailable." }, 503);
  }
}
