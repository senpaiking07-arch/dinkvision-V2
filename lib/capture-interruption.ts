const reasons = {
  camera_disconnected: {
    label: "Camera disconnected",
    apology: "Sorry, your recording ended early because the camera disconnected during the match.",
  },
  camera_failure: {
    label: "Camera failure",
    apology: "Sorry, your recording ended early because the camera stopped working during the match.",
  },
  storage_full: {
    label: "Insufficient device storage",
    apology: "Sorry, your recording ended early because the recording device ran low on storage.",
  },
  app_interrupted: {
    label: "Recorder stopped unexpectedly",
    apology: "Sorry, your recording ended early because the recorder stopped unexpectedly.",
  },
  unknown: {
    label: "Cause unconfirmed",
    apology: "Sorry, your recording ended unexpectedly. We could not confirm the cause.",
  },
};

export function isCaptureInterruption(value: unknown): value is keyof typeof reasons {
  return typeof value === "string" && Object.hasOwn(reasons, value);
}

export function captureInterruptionLabel(code: unknown) {
  return isCaptureInterruption(code) ? reasons[code].label : null;
}

export function captureDurationLabel(durationMs: unknown) {
  if (typeof durationMs !== "number" || !Number.isSafeInteger(durationMs) || durationMs < 1)
    return null;
  const total = Math.max(1, Math.floor(durationMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const parts = [];
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  if (seconds) parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
  return parts.join(" ");
}

export function captureInterruptionNotice(code: unknown, durationMs: unknown) {
  if (!isCaptureInterruption(code)) return null;
  const duration = captureDurationLabel(durationMs);
  const recovered = duration ? `We recovered ${duration} of footage.` : "We recovered the available footage.";
  return `${reasons[code].apology} ${recovered} You can watch the available recording below.`;
}
