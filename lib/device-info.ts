import { InputError } from "./validation";

export type DeviceInfo = {
  platform: "android"; manufacturer: string; model: string; android_version: string;
  android_sdk: number; app_version: string; app_version_code: number; reported_at: string;
  usb_cameras: { name: string; manufacturer: string; vendor_id: number; product_id: number }[];
  microphone_input?: string;
  recording_profile?: string;
};

export function deviceInfoInput(value: unknown, reportedAt = new Date().toISOString()): DeviceInfo {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 4096)
    throw new InputError("Invalid device details.");
  const data = value as Record<string, unknown>;
  const label = (v: unknown, max = 80) => {
    if (typeof v !== "string" || !v.trim() || v.length > max || /[\x00-\x1f]/.test(v)) throw new InputError("Invalid device details.");
    return v.trim();
  };
  const number = (v: unknown, max: number) => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > max) throw new InputError("Invalid device details.");
    return v;
  };
  if (data.platform !== "android" || !Array.isArray(data.usb_cameras) || data.usb_cameras.length > 4)
    throw new InputError("Invalid device details.");
  return {
    platform: "android", manufacturer: label(data.manufacturer), model: label(data.model),
    android_version: label(data.android_version, 32), android_sdk: number(data.android_sdk, 1000),
    app_version: label(data.app_version, 32), app_version_code: number(data.app_version_code, 2147483647),
    reported_at: reportedAt,
    ...(data.microphone_input === undefined ? {} : {microphone_input: label(data.microphone_input, 160)}),
    ...(data.recording_profile === undefined ? {} : {recording_profile: label(data.recording_profile, 160)}),
    usb_cameras: data.usb_cameras.map(camera => {
      if (!camera || typeof camera !== "object" || Array.isArray(camera)) throw new InputError("Invalid camera details.");
      return { name: label(camera.name), manufacturer: label(camera.manufacturer),
        vendor_id: number(camera.vendor_id, 65535), product_id: number(camera.product_id, 65535) };
    }),
  };
}
