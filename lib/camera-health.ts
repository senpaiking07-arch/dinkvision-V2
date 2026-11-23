type CameraDevice = {
  enabled?: boolean;
  kiosk_id?: string | null;
  tested_at?: string | null;
  recorder_mode?: string | null;
  device_info?: {
    reported_at?: string | null;
    usb_cameras?: { name?: string | null; manufacturer?: string | null }[] | null;
  } | null;
};

export type CameraHealth = {
  state: "disabled" | "unpaired" | "offline" | "stale" | "unknown" | "disconnected" | "untested" | "ready";
  label: string;
  tone: "is-success" | "is-warning" | "is-danger" | "";
  detail: string;
};

const REPORT_FRESH_MS = 120_000;
const CLOCK_SKEW_MS = 30_000;

// A passed camera test is historical. Keep it separate from the recorder's
// connectivity and from the USB camera list in its latest check-in.
export function cameraHealth(
  device: CameraDevice,
  presence: { connected: boolean },
  now: number,
): CameraHealth {
  if (!device.enabled)
    return { state: "disabled", label: "Camera unavailable", tone: "", detail: "This recorder is disabled." };
  if (!device.kiosk_id)
    return { state: "unpaired", label: "Camera not registered", tone: "is-warning", detail: "Finish enrollment before checking this camera." };

  const info = device.device_info;
  const native = device.recorder_mode === "android_rtsp" || !!info;
  const tested = !!device.tested_at;

  if (!presence.connected)
    return {
      state: "offline",
      label: tested ? "Camera tested · recorder offline" : "Camera status unknown",
      tone: "is-warning",
      detail: tested
        ? "The last camera check passed before the recorder went offline."
        : "Reconnect the recorder to verify its camera.",
    };

  if (native && info) {
    const reported = Date.parse(info.reported_at || "");
    const fresh = Number.isFinite(reported) && reported <= now + CLOCK_SKEW_MS && now - reported <= REPORT_FRESH_MS;
    if (!fresh)
      return { state: "stale", label: "Camera report stale", tone: "is-warning", detail: "The recorder is online but its camera inventory is older than two minutes." };
    if (!Array.isArray(info.usb_cameras))
      return { state: "unknown", label: "USB camera inventory unavailable", tone: "is-warning", detail: "The latest check-in did not include a USB camera list." };
    if (!info.usb_cameras.length)
      return { state: "disconnected", label: "USB camera not detected", tone: "is-danger", detail: "The recorder is online, but its latest check-in reported no USB camera." };
  }

  if (tested)
    return {
      state: "ready",
      label: native && info ? "Camera ready" : "Camera tested",
      tone: "is-success",
      detail: native && info
        ? "The latest check-in reports a USB camera and the last camera check passed."
        : "The last camera check passed.",
    };

  return { state: "untested", label: "Camera check needed", tone: "is-warning", detail: "Run the camera check on the recorder to verify its picture and sound." };
}
