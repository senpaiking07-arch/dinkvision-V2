import { browserTablet, publicTablet } from "@/lib/browser-tablets";
import { recorderDatabase } from "@/lib/recorder-server";
import { json, readBody, sameOrigin } from "@/lib/http";
import { nativeTabletCameraFields } from "@/lib/tablet-camera-config";
import { InputError, uuid } from "@/lib/validation";

const activeCaptureStatuses = ["requested", "starting", "recording", "finalizing"];

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Invalid origin." }, 403);
  try {
    const t = await browserTablet();
    if (!t) return json({ error: "Enroll this tablet first." }, 401);
    const b = await readBody(request);
    if (b.action === "configure") {
      const expectedRevision = uuid(b.expected_revision);
      if (t.kiosk.current_session_id) {
        const current = await recorderDatabase(t.kiosk.tenant_id)
          .from("recording_sessions")
          .select("status")
          .eq("id", t.kiosk.current_session_id)
          .eq("kiosk_id", t.kiosk.id)
          .maybeSingle();
        if (current.error) throw current.error;
        if (current.data && activeCaptureStatuses.includes(current.data.status))
          return json(
            { error: "Finish the current recording before changing camera settings." },
            409,
          );
      }
      const fields = nativeTabletCameraFields(b, t.device);
      const updated = await recorderDatabase(t.kiosk.tenant_id)
        .from("browser_devices")
        .update(fields)
        .eq("id", t.device.id)
        .eq("kiosk_id", t.kiosk.id)
        .eq("config_revision", expectedRevision)
        .select("*")
        .maybeSingle();
      if (updated.error) {
        if (updated.error.code === "P0001")
          return json(
            { error: "Finish or recover the current recording before changing camera settings." },
            409,
          );
        throw updated.error;
      }
      if (!updated.data)
        return json(
          { error: "Camera settings changed elsewhere. Reopen Device setup and try again." },
          409,
        );
      return json({ ok: true, device: publicTablet(updated.data) });
    }
    if (
      t.device.recorder_mode !== "android_rtsp" ||
      t.device.video_device !== "android-camera-v1"
    )
      return json(
        {
          error:
            "Open Device setup and choose the USB or built-in Android camera.",
        },
        409,
      );
    if (b.action === "configuration") {
      return json({
        revision: t.device.config_revision,
        camera: {
          type: "device",
          name: "Android USB / built-in camera",
          audio: true,
        },
      });
    }
    if (b.action === "tested" && typeof b.passed === "boolean") {
      const revision = uuid(b.revision);
      if (revision !== t.device.config_revision)
        return json(
          { error: "Camera settings changed during the test. Tap Record another test." },
          409,
        );
      if (t.kiosk.current_session_id) {
        const current = await recorderDatabase(t.kiosk.tenant_id)
          .from("recording_sessions")
          .select("status")
          .eq("id", t.kiosk.current_session_id)
          .eq("kiosk_id", t.kiosk.id)
          .maybeSingle();
        if (current.error) throw current.error;
        if (current.data && activeCaptureStatuses.includes(current.data.status))
          return json(
            { error: "A match is still recording. Finish it before testing the camera again." },
            409,
          );
      }
      const r = await recorderDatabase(t.kiosk.tenant_id).rpc("native_camera_test", {
        p_kiosk: t.kiosk.id,
        p_revision: revision,
        p_passed: b.passed,
      });
      if (r.error) {
        console.error("Camera test confirmation failed", { code: r.error.code });
        return json(
          { error: "Could not save the camera test. Check the connection and try confirming again." },
          503,
        );
      }
      if (!r.data)
        return json(
          {
            error:
              "Camera setup or match status changed while saving. Tap Record another test when the court is idle.",
          },
          409,
        );
      return json({ ok: true });
    }
    return json({ error: "Unknown camera action." }, 400);
  } catch (error) {
    return json(
      {
        error:
          error instanceof InputError
            ? error.message
            : "Camera configuration unavailable. Check the connection and try again.",
      },
      error instanceof InputError ? 400 : 503,
    );
  }
}
