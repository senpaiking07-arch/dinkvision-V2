import { browserTablet } from "@/lib/browser-tablets";
import { decryptSecret } from "@/lib/google-crypto";
import { recorderDatabase } from "@/lib/recorder-server";
import { json, readBody, sameOrigin } from "@/lib/http";
import { uuid } from "@/lib/validation";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Invalid origin." }, 403);
  try {
    const t = await browserTablet();
    if (!t) return json({ error: "Enroll this tablet first." }, 401);
    if (t.device.recorder_mode !== "android_rtsp")
      return json(
        {
          error:
            "Select an Android camera mode for this device in the admin dashboard.",
        },
        409,
      );
    const b = await readBody(request);
    if (b.action === "configuration") {
      if (t.device.video_device === "android-camera-v1")
        return json({
          revision: t.device.config_revision,
          camera: {
            type: "device",
            name: "Android built-in camera",
            audio: true,
          },
        });
      if (t.device.video_device !== "android-rtsp-v2")
        return json(
          {
            error:
              "Choose Android camera or Tapo Wi-Fi camera in the admin dashboard.",
          },
          409,
        );
      if (
        !t.device.rtsp_url ||
        !t.device.rtsp_username ||
        !t.device.rtsp_password_encrypted
      )
        return json(
          {
            error:
              "Complete the Tapo IP address and Camera Account details in the admin dashboard.",
          },
          409,
        );
      return json({
        revision: t.device.config_revision,
        camera: {
          type: "rtsp",
          name: t.device.camera_name,
          address: t.device.rtsp_url,
          user: t.device.rtsp_username,
          password: decryptSecret(t.device.rtsp_password_encrypted),
          audio: !!t.device.audio_device,
        },
      });
    }
    if (b.action === "tested" && typeof b.passed === "boolean") {
      const r = await recorderDatabase().rpc("native_camera_test", {
        p_kiosk: t.kiosk.id,
        p_revision: uuid(b.revision),
        p_passed: b.passed,
      });
      if (r.error || !r.data)
        return json(
          {
            error:
              "Camera settings changed or a match is active. Retry the test when idle.",
          },
          409,
        );
      return json({ ok: true });
    }
    return json({ error: "Unknown camera action." }, 400);
  } catch {
    return json(
      {
        error:
          "Camera configuration unavailable. Ask the administrator to check setup.",
      },
      503,
    );
  }
}
