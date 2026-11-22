"use client";
import {RecorderTimeline} from "@/components/recorder-timeline";
import { EnrollmentInvitation, enrollmentQrFromResponse, reserveEnrollmentTab, showEnrollmentTab, type EnrollmentQr } from "@/components/admin-enrollment-qr";
import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { videoRetryLabel } from "@/lib/upload-recovery";
import { captureInterruptionLabel } from "@/lib/capture-interruption";
import { recordingDisplayLabel } from "@/lib/recording-label";
import { recordingIsConfirmed } from "@/lib/recording-status";
import type { DeviceInfo } from "@/lib/device-info";
import { localProcessingLabel, reportedBrandingProgress, recordingStageLabel } from "@/lib/local-video-status";
import { devicePresence } from "@/lib/device-presence";
import {recordingSizeMb,uploadSizeMb} from "@/lib/recording-size";
import {deviceQueueOrder,isQueuedWork,visibleDeviceQueueItem,isLocalOnlyHistory} from "@/lib/device-queue-order";

type AdminTabletAction = {action: string; id?: string; [key: string]: unknown};

export default function BrowserTabletsAdmin() {
  const [data, setData] = useState<any>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [qrEnrollment, setQrEnrollment] = useState<EnrollmentQr | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [selected, setSelected] = useState<any>(null),
    [removing, setRemoving] = useState<any>(null),
    [cancellingUpload, setCancellingUpload] = useState<any>(null);
  const [newTabletVersion, setNewTabletVersion] = useState(0);
  const [connectionNotice, setConnectionNotice] = useState("");
  const [replacingEnrollment,setReplacingEnrollment]=useState<AdminTabletAction|null>(null);
  const tabletEditor = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!newTabletVersion) return;
    tabletEditor.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
    tabletEditor.current
      ?.querySelector<HTMLInputElement>('input[name="name"]')
      ?.focus({ preventScroll: true });
  }, [newTabletVersion]);
  async function refresh() {
    try {
      const r = await fetch("/api/admin/tablets");
      setConnectionNotice(navigator.onLine ? "" : "No internet connection detected. Displayed device states may be stale.");
      const d = await r.json();
      if (!r.ok) throw Error(d.error);
      setData({...d,receivedAt:Date.now()});
      return d;
    } catch (e) {
      if (e instanceof TypeError) setConnectionNotice(navigator.onLine
        ? "Network available, but the application server cannot be reached. Internet access is not verified. Retrying automatically."
        : "No internet connection detected. Displayed device states may be stale.");
      else setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    const offline = () => setConnectionNotice("No internet connection detected. Displayed device states may be stale.");
    window.addEventListener("offline", offline);
    return () => { clearInterval(t); window.removeEventListener("offline", offline); };
  }, []);
  async function action(body: AdminTabletAction) {
    const opensQr = body.action === "enroll" || (body.action === "save" && !body.id);
    const qrTab = opensQr ? reserveEnrollmentTab() : null;
    let openedInvitation = false;
    setBusy(true);
    setError("");
    setQrEnrollment(null);
    try {
      const r = await fetch("/api/admin/tablets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if(r.status===409 && d.replacementRequired){setReplacingEnrollment(body);return false;}
      if (!r.ok) throw Error(d.error);
      if (opensQr) {
        const invitation = enrollmentQrFromResponse(d);
        if (!invitation) throw Error("The enrollment invitation is unavailable. Create a new QR.");
        openedInvitation = showEnrollmentTab(qrTab, invitation);
        if (!openedInvitation) setQrEnrollment(invitation);
      }
      const updated = await refresh();
      const selectedId = d.id || selected?.id;
      if (selectedId && updated)
        setSelected(
          updated.devices.find((item: any) => item.id === selectedId) || null,
        );
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      if (!openedInvitation) qrTab?.close();
      setBusy(false);
    }
  }
  async function retryEmail(fileId: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: fileId }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      setNotice("Replay email queued. Its delivery status will update here.");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const activeCourts = (data?.courts || []).filter(
    (court: any) => court.active,
  );
  const availableCourts = activeCourts.filter(
    (court: any) =>
      court.id === selected?.court_id ||
      !(data?.devices || []).some(
        (device: any) =>
          device.id !== selected?.id && device.court_id === court.id,
      ),
  );
  const hiddenCourtCount = activeCourts.length - availableCourts.length;
  const selectedRecording = selected
    ? data?.recordings?.find((item: any) => item.device_id === selected.id)
    : null;
  const canCancelSelectedUpload =
    selectedRecording &&
    ["queued", "uploading", "failed"].includes(
      selectedRecording.upload_state,
    );
  const selectedRetryLabel = videoRetryLabel(selectedRecording, selected?.recorder_mode === "android_rtsp");
  return (
    <section className="admin-card browser-devices">
      {connectionNotice && <p role="status" className="form-note">{connectionNotice}</p>}
      {notice && <p role="status" className="form-note">{notice}</p>}
      <div className="section-heading">
        <div>
          <h2>Devices & cameras</h2>
          <p>Dink Vision · Manage browser and Android camera devices.</p>
        </div>
        <button
          className="secondary"
          type="button"
          disabled={busy || loading}
          onClick={() => {
            setSelected(null);
            setError("");
            setNewTabletVersion((v) => v + 1);
          }}
        >
          Add device
        </button>
      </div>
      <div className="browser-device-grid">
        <section className="browser-device-column" aria-busy={loading}>
          <div className="tablet-panel-heading">
            <div>
              <h3>Registered devices</h3>
              <p>Select a device to review its court and connection status.</p>
            </div>
            {data && (
              <span className="tablet-count">
                {data.devices.length} {data.devices.length === 1 ? "device" : "devices"}
              </span>
            )}
          </div>
          <div className="browser-device-list">
          {loading && (
            <div className="tablet-loading" role="status">
              <span className="tablet-loading-spinner" aria-hidden="true" />
              <div>
                <strong>Loading devices…</strong>
                <small>Checking assignments and camera status.</small>
              </div>
            </div>
          )}
          {!loading && data?.devices?.map((d: any) => {
            const now=(Date.parse(data.serverTime||"")||Date.now())+Math.max(0,Date.now()-(data.receivedAt||Date.now()));
            const deviceQueue = data.recordings.filter(
              (r: any) => r.device_id === d.id && visibleDeviceQueueItem(r,now),
            );
            const recording = deviceQueue[0];
            const queueSummary = (status: string) =>
              deviceQueue.filter((r: any) => r.upload_state === status).length;
            const activeQueueCount =
              queueSummary("pending") + queueSummary("queued") + queueSummary("retrying");
            const queueItems = deviceQueueOrder(deviceQueue.filter((item: any) =>
              ["saved_locally", "pending", "queued", "retrying", "uploading", "failed", "local_only","uploaded"].includes(
                item.upload_state,
              ),
            ), now);
            const historyQueue=queueItems.filter(isLocalOnlyHistory);
            const visibleQueue=queueItems.filter(item=>!isLocalOnlyHistory(item));
            const queuePositions=new Map(queueItems.filter(isQueuedWork).map((item,index)=>[item.session_id,index+1]));
            const presence=devicePresence(d,now),online=presence.connected,deviceStatus=presence.label;
            const captureUnconfirmed = recording?.recording_sessions?.status === "recording" &&
              !recordingIsConfirmed(recording.recording_sessions, recording, now);
            const readyFile = recording?.recording_sessions?.recording_files?.find(
              (file: any) => file.status === "ready" && file.storage_provider === "r2" && file.storage_key,
            );
            const emailStatus = readyFile?.email_jobs?.status;
            const selectDevice = () => {
              setSelected(d);
            };
            const hardware = d.device_info as DeviceInfo | null;
            return (
              <div
                className={`browser-device-card ${selected?.id === d.id ? "selected" : ""}`}
                key={d.id}
                role="button"
                tabIndex={0}
                onClick={selectDevice}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  selectDevice();
                }}
              >
                <strong>{d.name}</strong>
                <span>
                  {data.courts.find((c: any) => c.id === d.court_id)?.name ||
                    "No court assigned"}
                </span>
                <span className="tablet-status-line">
                  {!online && (
                    <span className="device-status-pill">{deviceStatus}</span>
                  )}
                  <span>
                    {d.tested_at
                      ? "Camera ready"
                      : d.recorder_mode !== "browser"
                        ? "Automatic camera check pending"
                        : "Camera setup needed"}
                  </span>
                </span>
                <small>
                  {d.camera_name || "No camera selected"}
                  {recording ? ` · ${captureUnconfirmed ? "recording unconfirmed" : recording.upload_state === "local_only" ? "local clip saved" : recording.upload_state === "failed" ? "needs attention" : recording.recording_sessions.status}` : ""}
                  {recording && localProcessingLabel(recording, now) ? ` · ${localProcessingLabel(recording, now)}` : ""}
                </small>
                <details className="device-hardware-details" onClick={event => event.stopPropagation()}>
                  <summary>Device details</summary>
                  {hardware ? <dl>
                    <dt>Device</dt><dd>{hardware.manufacturer} {hardware.model}</dd>
                    <dt>Android</dt><dd>{hardware.android_version} · API {hardware.android_sdk}</dd>
                    <dt>APK</dt><dd>{hardware.app_version} · build {hardware.app_version_code}</dd>
                    <dt>USB cameras attached</dt><dd>{hardware.usb_cameras.length ? hardware.usb_cameras.map(camera => camera.name).join(", ") : "None reported"}</dd>
                    <dt>Camera configuration</dt><dd>{d.camera_name || "Not configured"}</dd>
                    <dt>Microphone (last report)</dt><dd>{hardware.microphone_input || "Not reported yet"}</dd>
                    <dt>Camera mode (last report)</dt><dd>{hardware.recording_profile || "Run the camera check to report resolution and target frame rate"}</dd>
                    <dt>Last report</dt><dd>{new Date(hardware.reported_at).toLocaleString()}</dd>
                  </dl> : <p>Device details have not been reported yet.</p>}
                  <small>Reported by the device. Attached cameras still require a successful recording test.</small>
                    <RecorderTimeline deviceId={d.id}/>
                </details>
                <span className="device-queue-overview">
                  <strong>Upload queue</strong>
                  <span>{deviceQueue.filter((item:any)=>item.local_available!==false&&["saved_locally","local_only"].includes(item.upload_state)).length} saved</span>
                  <span>{activeQueueCount} pending</span>
                  <span>{queueSummary("uploading")} uploading</span>
                  <span>{queueSummary("failed")} failed</span>
                </span>
                {[{history:false,items:visibleQueue},{history:true,items:historyQueue}].map(group => {
                  const Wrapper = group.history ? 'details' : 'div';
                  return group.items.length > 0 && (
                  <Wrapper key={String(group.history)} className="device-queue-items" aria-label={`${d.name} ${group.history ? 'local-only history' : 'upload items'}`} onClick={event=>event.stopPropagation()}>
                    {group.history && <summary>Local-only videos ({historyQueue.length})</summary>}
                    {group.items.map((item: any) => {
                      const itemRetryLabel = videoRetryLabel(item, d.recorder_mode === "android_rtsp");
                      const interruption = captureInterruptionLabel(item.recording_sessions?.capture_interruption_code);
                      const label = recordingDisplayLabel(item.recording_sessions, item.client_created_at, data.timeZone);
                      const brandingPercent=reportedBrandingProgress(item);
                      const brandingLive=localProcessingLabel(item,now)==="Adding logo";
                      const percent = item.bytes
                        ? Math.min(
                            100,
                            Math.floor(
                              (Number(item.uploaded_bytes || 0) / Number(item.bytes)) * 100,
                            ),
                          )
                        : 0;
                      const errorDetail = item.recording_sessions?.capture_inspection_required && item.local_available !== false
                        ? "Save the original from Saved videos on the tablet for inspection."
                        : (item.branding_state ? `Logo: ${String(item.branding_state).replaceAll("_", " ")}. ` : "Logo status unavailable. ") +
                          (item.last_error || item.safe_error || "No detailed error was reported by the device.");
                      return (
                        <span className="device-queue-item" key={item.job_id || item.session_id} data-session-id={item.session_id}>
                          {queuePositions.has(item.session_id) && <span className="device-queue-number" aria-label={`Device queue order ${queuePositions.get(item.session_id)}`}>{queuePositions.get(item.session_id)}</span>}
                          <a className="device-queue-item-title" href={`/admin?recording=${encodeURIComponent(item.session_id)}`}
                            title={`${label.full} · Open recording log`} aria-label={`Open recording log for ${label.full}`}
                            onClick={event => event.stopPropagation()}>
                            <span className="device-queue-item-date">{label.date}</span>
                            <span className="device-queue-item-recipients">{label.recipients}</span>
                          </a>
                          <span className="device-queue-item-state">
                            {recordingStageLabel(item, now, d.recorder_mode === "android_rtsp")}
                          </span>
                          {interruption && <span className="device-queue-item-copy">Capture ended early · {interruption}</span>}
                          <span className="device-queue-item-size">{item.upload_state==="uploading"
                            ? uploadSizeMb(item.uploaded_bytes,item.bytes)
                            : `${item.branding_state==="processing"?"Source video":"Video size"}: ${recordingSizeMb(item.bytes)}`}</span>
                          {item.upload_state === "uploading" && item.branding_state !== "processing" && <span className="device-upload-meter" role="progressbar"
                            aria-label={`Upload progress for ${label.full}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                            <i style={{width:`${percent}%`}} />
                          </span>}
                          {item.branding_state === "processing" && <span className="device-logo-progress">
                            <span>{brandingPercent === null ? brandingLive ? "Device has not reported a percentage yet" : "Waiting for device to report progress"
                              : brandingLive ? `Adding logo · ${brandingPercent}%`
                              : `Last reported · ${brandingPercent}%`}</span>
                            {brandingPercent !== null ? <progress max={100} value={brandingPercent} aria-label="Logo processing progress" />
                              : <span className="device-progress-unreported" aria-hidden="true" />}
                          </span>}
                          {item.device_copy_saved_at && <span className="device-queue-item-copy">Copy exported to Gallery / Files · {new Date(item.device_copy_saved_at).toLocaleString()}</span>}
                          {item.upload_state === "failed" && (
                            <span className="device-queue-item-error">{errorDetail}</span>
                          )}
                          {itemRetryLabel && (
                            <button
                              type="button"
                              className="device-continue-upload device-queue-retry"
                              disabled={busy}
                              aria-label={`${itemRetryLabel} for ${label.full}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                void action({
                                  action: "retry-upload",
                                  id: d.id,
                                  session_id: item.session_id,
                                }).then((ok) => {
                                  if (ok)
                                    setNotice("Retry requested. The original tablet must connect to process and upload this video. Validation must pass before upload.");
                                });
                              }}
                            >
                              {busy ? "Requesting…" : itemRetryLabel}
                            </button>
                          )}
                        </span>
                      );
                    })}
                  </Wrapper>
                );})}
                {readyFile && (
                  <span className="device-upload-status">
                    <span>
                      <strong>Upload complete</strong>
                      <small>
                        {emailStatus === "sent" ? "Replay email sent. Check Gmail and Spam."
                          : emailStatus === "failed" ? "Your video is saved. Replay email failed; retry below."
                            : emailStatus === "unknown" ? "Your video is saved. Email delivery needs administrator review."
                              : "Your video is saved. Replay email is pending."}
                      </small>
                      {emailStatus === "failed" && (
                        <button type="button" className="device-continue-upload" disabled={busy}
                          onClick={(event) => {
                            event.stopPropagation();
                            void retryEmail(readyFile.id);
                          }}>
                          {busy ? "Requesting…" : "Retry replay email"}
                        </button>
                      )}
                    </span>
                  </span>
                )}
              </div>
            );
          })}
          {!loading && data?.devices?.length === 0 && (
            <div className="tablet-empty-state">
              <strong>No devices registered yet</strong>
              <p>
                Use Add device to name the recorder and assign its court. The
                camera is selected and tested on the enrolled physical device.
              </p>
            </div>
          )}
          </div>
        </section>
        <section className="tablet-editor-panel">
        <form
          ref={tabletEditor}
          key={`${selected?.id || "new"}-${newTabletVersion}`}
          className="stack-form tablet-editor"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void action({
              action: "save",
              id: selected?.id,
              name: f.get("name"),
              court_id: f.get("court_id"),
            });
          }}
        >
          <div className="tablet-editor-heading">
            <div>
              <h3>{selected ? "Edit device" : "Add device"}</h3>
              <p>
                {selected
                  ? "Update its name or court. Camera selection stays on the physical device."
                  : "Name the device, assign its court, then enroll and select its camera on the physical device."}
              </p>
            </div>
            <span className="status-tag">
              {selected ? "Editing" : "New device"}
            </span>
          </div>
          <fieldset className="tablet-fields" disabled={busy || loading}>
            <label>
              <span>Device name</span>
              <input
                name="name"
                required
                maxLength={100}
                defaultValue={selected?.name || ""}
                placeholder="Example: Court 1 Tablet"
              />
              <small>A clear name helps staff identify the physical device.</small>
            </label>
            <label>
              <span>Assigned court</span>
              <select name="court_id" defaultValue={selected?.court_id || ""}>
                <option value="">Unassigned</option>
                {availableCourts.map((court: any) => (
                    <option key={court.id} value={court.id}>
                      {court.name}
                    </option>
                  ))}
              </select>
              <small>
                {hiddenCourtCount
                  ? `${hiddenCourtCount} ${hiddenCourtCount === 1 ? "court is" : "courts are"} hidden because ${hiddenCourtCount === 1 ? "it is" : "they are"} already assigned.`
                  : "Only active, available courts are shown."}
              </small>
            </label>
            <div className="automatic-audio-note">
              <strong>Camera setup happens on this device</strong>
              <span>
                After enrollment, open the website’s tablet setup for browser
                recording or Device setup in the Android APK. The device will
                choose and test its own camera without another enrollment code.
              </span>
            </div>
          </fieldset>
          {selected && (
            <div className="tablet-device-details">
              <span>Device ID</span>
              <code>{selected.id}</code>
              <p>
                {selected.diagnostic ||
                  "Camera settings and permissions are configured on the physical tablet."}
              </p>
            </div>
          )}
          <div className="tablet-primary-action">
            <button className="primary" type="submit" disabled={busy || loading}>
              {selected ? "Save changes" : "Create pairing invitation"}
            </button>
          </div>
          {selected && selected.enabled && (
            <div className="tablet-management-actions">
              <div>
                <strong>Device actions</strong>
                <p>Enrollment changes apply to this device only. Camera checks run automatically.</p>
              </div>
              <div className="save-row">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void action({
                      action: "enroll",
                      id: selected.id,
                      name: selected.name,
                      court_id: selected.court_id,
                    })
                  }
                >
                  Re-enroll device
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void action({ action: "disable", id: selected.id })
                  }
                >
                  Disable device
                </button>
              </div>
            </div>
          )}
          {selected && !selected.enabled && (
            <div className="tablet-management-actions tablet-reenable">
              <div>
                <strong>Device disabled</strong>
                <p>
                  Re-enabling creates a fresh one-time QR. Scan it on the
                  physical device to reconnect securely.
                </p>
              </div>
              <button
                type="button"
                className="secondary"
                disabled={busy || !selected.court_id}
                onClick={() =>
                  void action({
                    action: "enroll",
                    id: selected.id,
                    name: selected.name,
                    court_id: selected.court_id,
                  })
                }
              >
                {busy ? "Re-enabling…" : "Re-enable device & get QR"}
              </button>
              {!selected.court_id && (
                <p className="form-note">
                  Assign and save a court before re-enabling this device.
                </p>
              )}
            </div>
          )}
          {selected && canCancelSelectedUpload && (
            <div className="tablet-management-actions upload-queue-actions">
              <div>
                <strong>Pending video upload</strong>
                <p>
                  Release the global upload queue without deleting the video
                  saved on this device. It can be retried later from the
                  original device.
                </p>
              </div>
              <div className="save-row">
                {selectedRetryLabel && (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void action({
                        action: "retry-upload",
                        id: selected.id,
                        session_id: selectedRecording.session_id,
                      })
                    }
                  >
                    {busy ? "Requesting…" : selectedRetryLabel}
                  </button>
                )}
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    setCancellingUpload({
                      device: selected,
                      recording: selectedRecording,
                    })
                  }
                >
                  Cancel upload
                </button>
              </div>
            </div>
          )}
          {selected && (
            <div className="device-danger-zone">
              <div>
                <strong>Delete device</strong>
                <p>Permanently delete this device and its enrollment, even during an active recording or upload. The recording is stopped and its upload cancelled; recording logs and uploaded videos are kept.</p>
              </div>
              <button
                type="button"
                className="remove-device-button"
                disabled={busy}
                onClick={() => setRemoving(selected)}
              >
                <Trash2 size={16} />
                Delete device
              </button>
            </div>
          )}
        </form>
        </section>
      </div>
      <section className="tablet-manual" aria-labelledby="tablet-manual-title">
        <div className="tablet-manual-heading">
          <span>GENERAL GUIDE</span>
          <h3 id="tablet-manual-title">Set up a court device</h3>
          <p>Complete these steps once for each browser or Android recording device.</p>
        </div>
        <ol>
          <li>
            <span>1</span>
            <div>
              <strong>Create and assign</strong>
              <p>
                Name the recording device and assign its court. Camera selection
                happens after enrollment on the physical device.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Enroll the physical device</strong>
              <p>Open <code>/tablet/setup</code> for a browser camera, or Device setup in the Android APK, then enter the one-time code.</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Confirm camera readiness</strong>
              <p>The browser setup page or Android APK selects the camera, records a short test clip, and saves the tested configuration.</p>
            </div>
          </li>
        </ol>
      </section>
      {cancellingUpload && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy)
              setCancellingUpload(null);
          }}
        >
          <section
            className="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cancel-upload-title"
            aria-describedby="cancel-upload-description"
          >
            <h2 id="cancel-upload-title">
              Cancel upload for {cancellingUpload.device.name}?
            </h2>
            <p id="cancel-upload-description">
              This releases the global upload queue so the next video can
              upload. The video is not deleted: it stays on the original device
              and can rejoin the end of the queue with Recover / retry upload.
            </p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="confirm-modal-actions">
              <button
                type="button"
                className="sign-in"
                disabled={busy}
                onClick={() => setCancellingUpload(null)}
              >
                Keep in queue
              </button>
              <button
                type="button"
                className="remove-court-button-solid"
                disabled={busy}
                onClick={() => {
                  void action({
                    action: "cancel-upload",
                    id: cancellingUpload.device.id,
                    session_id:
                      cancellingUpload.recording.recording_sessions.id,
                  }).then((cancelled) => {
                    if (cancelled) setCancellingUpload(null);
                  });
                }}
              >
                {busy ? "Cancelling…" : "Cancel upload & release global queue"}
              </button>
            </div>
          </section>
        </div>
      )}
      {removing && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setRemoving(null);
          }}
        >
          <section
            className="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-device-title"
            aria-describedby="remove-device-description"
          >
            <div className="confirm-modal-icon" aria-hidden="true">
              <Trash2 size={20} />
            </div>
            <h2 id="remove-device-title">Are you sure you want to delete {removing.name}?</h2>
            <p id="remove-device-description">
              This permanently deletes the device and disconnects its enrollment. Any active recording is stopped and marked failed, and any active or queued upload is cancelled so the next queued upload can begin. Existing recording logs and uploaded videos stay available, but unsent footage on the deleted device may no longer be recoverable.
            </p>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="confirm-modal-actions">
              <button
                type="button"
                className="sign-in"
                disabled={busy}
                onClick={() => setRemoving(null)}
              >
                Keep device
              </button>
              <button
                type="button"
                className="remove-court-button-solid"
                disabled={busy}
                onClick={() => {
                  void action({ action: "remove", id: removing.id, confirm: true }).then(
                    (removed) => {
                      if (!removed) return;
                      setRemoving(null);
                      setSelected(null);
                    },
                  );
                }}
              >
                {busy ? "Deleting…" : "Yes, delete permanently"}
              </button>
            </div>
          </section>
        </div>
      )}
      {replacingEnrollment && <div className="modal-backdrop" role="presentation"><section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="replace-enrollment-title">
        <h2 id="replace-enrollment-title">Replace the current registration?</h2>
        <p>The current device disconnects when the replacement is verified. Each invitation can enroll one installation.</p>
        <div className="confirm-modal-actions"><button type="button" className="sign-in" disabled={busy} onClick={()=>setReplacingEnrollment(null)}>Keep current registration</button>
          <button type="button" className="primary" disabled={busy} onClick={()=>{const pending=replacingEnrollment;setReplacingEnrollment(null);void action({...pending,replace_enrollment:true});}}>Create replacement invitation</button></div>
      </section></div>}
      {qrEnrollment && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setQrEnrollment(null);
          }}
        >
          <section
            className="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="enroll-title"
            aria-describedby="enroll-desc"
          >
            <h2 id="enroll-title">Enroll your device</h2>
            <p id="enroll-desc">Check the status of this single-use invitation.</p>
            <EnrollmentInvitation invitation={qrEnrollment}
              instructions="Scan this QR in DinkVision or enter the pairing code below."
              openTab={() => {
                if (showEnrollmentTab(reserveEnrollmentTab(), qrEnrollment)) setQrEnrollment(null);
              }} />
            <div className="confirm-modal-actions">
              <button
                type="button"
                className="primary"
                onClick={() => setQrEnrollment(null)}
              >
                Done
              </button>
            </div>
          </section>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
