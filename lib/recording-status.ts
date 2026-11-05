import type { Session } from "./admin-types";

export type CaptureReport = { session_id: string; last_seen_at: string | null };

// A stored capture status is not proof that the camera is still running.
// Keep an uncertain capture distinct from idle; only its device can reconcile footage.
export function recordingIsConfirmed(session: Session, report: CaptureReport | undefined, now: number) {
  if (session.status !== "recording") return false;
  const seen = Date.parse(report?.last_seen_at || "");
  const started = Date.parse(session.started_at || "");
  if (!Number.isFinite(seen) || !Number.isFinite(started) || seen > now + 30_000 || started > now + 30_000 || now - seen > 45_000)
    return false;
  const duration = session.duration_seconds;
  return !(duration && duration > 0 && now > started + duration * 1000 + 30_000);
}

export function sessionCaptureReport(session: Session): CaptureReport {
  const records = session.configuration_snapshot?.capture_mode === "browser"
    ? session.browser_recordings : session.capture_jobs;
  const report = Array.isArray(records) ? records[0] : records;
  return { session_id: session.id, last_seen_at: report?.last_seen_at || null };
}
