import { InputError } from "./validation";

export function tabletCameraFields(
  body: Record<string, unknown>,
  previous: Record<string, any> = {},
) {
  const mode = String(
    body.recorder_mode ?? previous.recorder_mode ?? "browser",
  );
  if (!["browser", "android_camera"].includes(mode))
    throw new InputError("Choose a valid recorder type.");
  if (mode === "browser")
    return {
      recorder_mode: mode,
      ...(previous.recorder_mode !== "browser"
        ? {
            rtsp_url: "",
            rtsp_username: "",
            rtsp_password_encrypted: null,
            video_device: "",
            audio_device: "",
            tested_at: null,
            camera_name: "",
          }
        : {}),
    };
  return {
    // The deployed schema historically names all native Android capture
    // "android_rtsp". Keep that storage value for compatibility while only
    // accepting the USB/built-in device mode at the API boundary.
    recorder_mode: "android_rtsp",
    rtsp_url: "",
    rtsp_username: "",
    rtsp_password_encrypted: null,
    camera_name: "Android USB / built-in camera",
    source_type: "local",
    video_device: "android-camera-v1",
    audio_device: "device-microphone",
    stream_url: "",
  };
}

export function nativeTabletCameraFields(
  body: Record<string, unknown>,
  previous: Record<string, any> = {},
) {
  const mode = String(body.recorder_mode || "");
  if (mode !== "android_camera")
    throw new InputError("Choose the USB or built-in Android camera.");
  return tabletCameraFields(body, previous);
}
