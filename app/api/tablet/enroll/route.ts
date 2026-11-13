import { createHmac, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { json, readBody, sameOrigin } from "@/lib/http";
import { hashKiosk, kioskCookie, kioskDevice } from "@/lib/kiosk";
import { recorderDatabase, systemDatabase } from "@/lib/recorder-server";
import { androidUpdateRequired } from "@/lib/android-release";
import { enrollmentCode, enrollmentPin, legacyEnrollmentCode, qrVerifier } from "@/lib/tablet-enrollment";
import { missingColumns, qrColumns } from "@/lib/optional-schema";

async function enrolled(token: string, setup?: string) {
  const store = await cookies();
  const options = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
  };
  store.set(kioskCookie, token, { ...options, maxAge: 180 * 86400 });
  store.set("cb-tablet-setup", setup || "", { ...options, maxAge: setup ? 900 : 0 });
  return json({ ok: true });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Invalid origin." }, 403);
  try {
    const update = androidUpdateRequired(request);
    if (update) return json(update, 426);
    const b = await readBody(request);
    const qr = b.invite !== undefined;
    const code = typeof b.code === "string" ? b.code.trim() : "";
    const invite = typeof b.invite === "string" ? b.invite : "";
    const pin = typeof b.pin === "string" ? b.pin : "";
    if (qr && (b.code !== undefined || !legacyEnrollmentCode.test(invite) || !enrollmentPin.test(pin)))
      return json({ error: "Scan the enrollment QR and enter the six-digit PIN from Admin." }, 400);
    if (!qr && !enrollmentCode.test(code))
      return json(
        { error: "Enter the full enrollment code from your administrator." },
        400,
      );
    const attempt = b.attempt;
    if ((attempt !== undefined && (typeof attempt !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(attempt))) ||
        (b.recover === true && attempt === undefined))
      return json({ error: "Invalid enrollment attempt." }, 400);
    const key = process.env.SUPABASE_SECRET_KEY;
    if (attempt && !key) throw new Error("Enrollment is unavailable.");
    // Recover the same server-issued credential if the tablet lost its reply.
    // A code alone, or a new attempt proof, cannot reconstruct that credential.
    const verifier = qr ? qrVerifier(invite, pin) : code;
    const issue = (purpose: string) => attempt
      ? createHmac("sha256", key!).update(`dinkvision:enrollment:v1:${purpose}:${verifier}:${attempt}`).digest("base64url")
      : randomBytes(32).toString("base64url");
    const token = issue("device"), setup = issue("setup");
    const tokenHash = hashKiosk(token);
    const system = systemDatabase();
    const old = await kioskDevice();
    async function committedEnrollment() {
      if (!attempt) return null;
      const kiosk = await system.from("kiosk_devices").select("id,tenant_id")
        .eq("token_hash", tokenHash).eq("active", true).maybeSingle();
      if (kiosk.error) throw kiosk.error;
      if (!kiosk.data) return null;
      if (old && old.id !== kiosk.data.id)
        return json({ error: "This tablet already has a different active registration." }, 409);
      const device = await recorderDatabase(kiosk.data.tenant_id).from("browser_devices")
        .select("setup_hash,setup_expires_at").eq("kiosk_id", kiosk.data.id).eq("enabled", true).maybeSingle();
      if (device.error) throw device.error;
      if (!device.data) return null;
      const canSetup = device.data.setup_hash === hashKiosk(setup) &&
        Date.parse(device.data.setup_expires_at || "") > Date.now();
      return enrolled(token, canSetup ? setup : undefined);
    }
    const committed = await committedEnrollment();
    if (committed) return committed;
    if (b.recover === true)
      return json({ code: "enrollment_not_committed", error: "This enrollment attempt has not been confirmed." }, 404);

    if (old) {
      const previous = recorderDatabase(old.tenant_id);
      const existing = await previous
        .from("browser_devices")
        .select("id")
        .eq("kiosk_id", old.id)
        .maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data && b.replace !== true)
        return json(
          {
            replacementRequired: true,
            error:
              "This browser is already registered. Choose Re-enroll device to replace its current registration.",
          },
          409,
        );
      if (old.current_session_id) {
        const session = await previous
          .from("recording_sessions")
          .select("status")
          .eq("id", old.current_session_id)
          .single();
        if (
          session.error ||
          ["requested", "starting", "recording", "finalizing"].includes(
            session.data.status,
          )
        )
          return json(
            { error: "Finish the current recording before enrolling." },
            409,
          );
      }
    }
    const d = await system
      .from("browser_devices")
      .select("id,tenant_id")
      .eq(qr ? "enrollment_qr_hash" : "enrollment_hash", hashKiosk(qr ? invite : code))
      .maybeSingle();
    if (qr && missingColumns(d.error, qrColumns))
      return json({ error: "QR enrollment needs the database update. Ask Admin for a manual code." }, 503);
    if (d.error) throw d.error;
    if (!d.data)
      return await committedEnrollment() || json({
        code: "enrollment_code_unavailable",
        error: qr ? "This enrollment QR is invalid, expired, or already used." : "Enrollment code is invalid, expired, or already used.",
      }, 400);
    if (old && old.tenant_id !== d.data.tenant_id)
      return json({ error: "Enroll devices within the same venue." }, 409);
    const db = recorderDatabase(d.data.tenant_id);
    const audit = await db
      .from("audit_events")
      .select("actor_id")
      .eq("action", "tablet.enrollment_created")
      .contains("safe_detail", { device_id: d.data.id })
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (!audit.data?.actor_id) throw new Error();
    const r = await db.rpc(qr ? "enroll_browser_qr" : "enroll_browser", {
      ...(qr ? { p_invite: hashKiosk(invite) } : {}),
      p_hash: hashKiosk(verifier),
      p_token: tokenHash,
      p_setup: hashKiosk(setup),
      p_admin: audit.data.actor_id,
      p_previous_kiosk: old?.id || null,
    });
    if (r.error)
      return await committedEnrollment() || json(
        {
          error:
              "Code expired, already used, or a device has unfinished videos. Finish its recording and uploads before changing registrations.",
        },
        409,
      );
    if (!r.data)
      return await committedEnrollment() || json({
        code: "enrollment_code_unavailable",
        error: qr ? "PIN incorrect or the QR is no longer available. Check the PIN. Ask Admin for a new QR if it expired or reached five incorrect attempts."
          : "The pairing code is invalid, expired, or already used. Ask Admin for a new invitation.",
      }, 400);
    return enrolled(token, setup);
  } catch {
    return json({ error: "Could not enroll. Please retry." }, 503);
  }
}
