import release from "../android/recorder-release.json";

export type AndroidRelease = {
  versionName: string; versionCode: number; required: boolean; downloadUrl: string;
};

// Activation is a separate deployment step after the signed APK is downloadable.
export function androidRelease(env: Record<string, string | undefined> = process.env): AndroidRelease {
  const required = env.ANDROID_REQUIRE_LATEST === "true";
  const raw = env.ANDROID_APK_DOWNLOAD_URL?.trim() || "";
  let downloadUrl = "";
  if (raw) {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error("ANDROID_APK_DOWNLOAD_URL must be an HTTPS APK download URL without credentials or a fragment.");
    downloadUrl = url.href;
  }
  if (required && !downloadUrl)
    throw new Error("Publish and configure the approved APK before enabling ANDROID_REQUIRE_LATEST.");
  // Installed Android clients require a three-part version label in policy responses.
  const versionName = release.versionName.replace(/^(\d+\.\d+)$/, "$1.0");
  return { ...release, versionName, required, downloadUrl };
}

export function androidUpdateRequired(request: Request, androidDevice = false, policy = androidRelease()) {
  const native = androidDevice || request.headers.get("x-dinkvision-client") === "android"
    || /^Dalvik\//.test(request.headers.get("user-agent") || "");
  if (!native || !policy.required) return null;
  const header = request.headers.get("x-dinkvision-version-code") || "";
  const code = /^\d{1,10}$/.test(header) ? Number(header) : 0;
  return code >= policy.versionCode ? null : {
    error: `Update DinkVision to ${policy.versionName} before starting another match. Saved footage remains on this device.`,
    release: policy,
  };
}
