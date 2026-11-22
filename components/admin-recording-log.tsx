import { ChevronRight, Play } from "lucide-react";
import type { Session } from "@/lib/admin-types";
import { recordingDiagnostics } from "@/lib/recording-diagnostics";
import { RecorderTimeline } from "@/components/recorder-timeline";

export const recordingStatuses: Record<string, string> = {
  requested: "Requested",
  starting: "Starting",
  recording: "Recording",
  finalizing: "Finalizing",
  local_ready: "Saved locally",
  uploading: "Uploading",
  upload_failed: "Upload failed",
  sharing: "Preparing replay",
  ready: "Ready to watch",
  failed: "Failed",
  deleting: "Deleting",
  deleted: "Deleted",
};

export function recordingLogStatus(session: Session) {
  const report = Array.isArray(session.browser_recordings) ? session.browser_recordings[0] : session.browser_recordings;
  return report?.upload_state === "failed" && session.status === "uploading" ? "upload_failed" : session.status;
}

type Props = {
  session: Session;
  court: string;
  recipients: string;
  timestamp: (value: string) => string;
  unconfirmed: boolean;
  focused: boolean;
  device?: string;
};

export function RecordingLogRow({ session, court, recipients, timestamp, unconfirmed, focused, device }: Props) {
  const diagnostics = recordingDiagnostics(session);
  const state = recordingLogStatus(session);
  const status = unconfirmed ? "Recording unconfirmed" : recordingStatuses[state] || state.replaceAll("_", " ");
  const tone = unconfirmed ? "is-warning" : state === "failed" || state === "upload_failed" ? "is-danger"
    : session.status === "ready" ? "is-success" : ["recording", "uploading", "finalizing"].includes(session.status) ? "is-live" : "";
  const camera = session.configuration_snapshot?.camera_name;
  return <li className="admin-log-item">
    <details open={focused || undefined}>
      <summary aria-label={`Details for ${court}, ${recipients}, ${timestamp(session.created_at)}`}>
        <span className="admin-log-identity"><strong>{recipients}</strong><span>{court} · {timestamp(session.created_at)}</span></span>
        <span className={`recorder-state ${tone}`}>{status}</span>
        <ChevronRight size={18} aria-hidden="true" />
      </summary>
      <div className="admin-log-detail">
        <div className="recorder-facts-grid">
          <section className="recorder-facts">
            <h4>Recording details</h4>
            <dl>
              <dt>Started</dt><dd>{session.started_at ? timestamp(session.started_at) : "Not started"}</dd>
              <dt>Stopped</dt><dd>{session.stopped_at ? timestamp(session.stopped_at) : "Not reported"}</dd>
              {device && <><dt>Recorder</dt><dd>{device}</dd></>}
              {camera && <><dt>Camera</dt><dd>{camera}</dd></>}
              <dt>Session ID</dt><dd><code>{session.id}</code></dd>
            </dl>
          </section>
          <section className="recorder-facts">
            <h4>What happened</h4>
            <dl>
              <dt>Reason</dt><dd>{diagnostics.reason}</dd>
              <dt>Stage</dt><dd>{diagnostics.stage}</dd>
              {diagnostics.detail && <><dt>Device report</dt><dd>{diagnostics.detail}</dd></>}
              {diagnostics.interruption && <><dt>Interrupted</dt><dd>{diagnostics.interruption}{session.capture_interrupted_at && ` · ${timestamp(session.capture_interrupted_at)}`}</dd></>}
              {diagnostics.recoveredDuration && <><dt>Recovered footage</dt><dd>{diagnostics.recoveredDuration}</dd></>}
            </dl>
          </section>
        </div>
        {unconfirmed && <p className="recorder-alert">The capture report is stale or its recording limit has passed. Reconnect the original recorder to reconcile this session and keep its saved videos.</p>}
        {diagnostics.help && <p className="admin-inline-note">{diagnostics.help}</p>}
        {session.status === "local_ready" && !diagnostics.help && <p className="admin-inline-note">Find the video on the original recorder using this session ID.</p>}
        <div className="recorder-diagnostics"><RecorderTimeline sessionId={session.id} /></div>
        <details className="recorder-disclosure">
          <summary>Reported codes</summary>
          <p>Reason <code>{session.stop_reason || "not reported"}</code> · Stage <code>{session.failure_stage || "not reported"}</code></p>
        </details>
        {session.status === "ready" && <a className="sign-in admin-watch-link" target="_blank" rel="noopener noreferrer"
          href={`/api/recordings/${encodeURIComponent(session.id)}/playback`}><Play size={15} aria-hidden="true" /> Watch recording</a>}
      </div>
    </details>
  </li>;
}
