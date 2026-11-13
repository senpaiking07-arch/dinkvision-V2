import { randomInt } from "node:crypto";
import { cookies } from "next/headers";
import { androidUpdateRequired } from "@/lib/android-release";
import { json, readBody, sameOrigin } from "@/lib/http";
import { hashKiosk, kioskCookie, kioskDevice } from "@/lib/kiosk";
import { systemDatabase } from "@/lib/recorder-server";
import { pairingKey, pairingLimit, pairingSecret, pairingPage } from "@/lib/tablet-pairing";
import { InputError, uuid } from "@/lib/validation";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Invalid origin." }, 403);
  try {
    const update = androidUpdateRequired(request);
    if (update) return json(update, 426);
    const body = await readBody(request);
    const id = uuid(body.id);
    const claim = body.claim;
    if (typeof claim !== "string" || !pairingSecret.test(claim)) throw new InputError("Invalid pairing request.");
    if (body.action !== "create" && body.action !== "claim") throw new InputError("Invalid pairing action.");
    if (!await pairingLimit(request, String(body.action), body.action === "create" ? 12 : 90, id))
      return json({ error: "Too many pairing checks. Wait a minute and try again." }, 429);
    const db = systemDatabase();
    const proof = hashKiosk(claim);
    if (body.action === "create") {
      const previous = await kioskDevice();
      if (previous && body.replace !== true)
        return json({ error: "Confirm that you want to re-enroll this tablet." }, 409);
      for (let attempt = 0; attempt < 5; attempt++) {
        const result = await db.rpc("create_tablet_pairing", {
          p_id: id, p_claim: proof, p_pin: String(randomInt(1_000_000)).padStart(6, "0"),
          p_previous: previous?.id ?? null,
        });
        if (result.error?.code === "23505") continue;
        if (result.error) throw result.error;
        if (!result.data) return json({ error: "Pairing request is unavailable." }, 404);
        const link = new URL(pairingPage, request.headers.get("origin")!);
        link.searchParams.set("request", id);
        return json({ ...result.data, link: link.href });
      }
      return json({ error: "Could not allocate a pairing number. Try again." }, 503);
    }
    const token = pairingKey("device", `${id}:${claim}`);
    const setup = pairingKey("setup", `${id}:${claim}`);
    const result = await db.rpc("claim_tablet_pairing", {
      p_id: id, p_claim: proof, p_token: hashKiosk(token), p_setup: hashKiosk(setup),
    });
    if (result.error?.code === "P0001")
      return json({ status: "approved", error: "Finish any active recording or unfinished videos before changing registrations, then check again." });
    if (result.error) throw result.error;
    if (result.data !== "enrolled") return json({ status: result.data });
    const store = await cookies();
    const options = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" as const, path: "/" };
    store.set(kioskCookie, token, { ...options, maxAge: 180 * 86400 });
    store.set("cb-tablet-setup", setup, { ...options, maxAge: 900 });
    return json({ status: "enrolled", ok: true });
  } catch (error) {
    return json({ error: error instanceof InputError ? error.message : "Pairing is unavailable. Check the connection and try again." },
      error instanceof InputError ? 400 : 503);
  }
}
