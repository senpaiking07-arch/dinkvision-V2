"use client";
import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";

function cameraIp(address: string | undefined) {
  if (!address) return "";
  try {
    return new URL(address).hostname;
  } catch {
    return "";
  }
}

function canContinueUpload(recording: any) {
  return (
    recording?.upload_state === "failed" &&
    Number(recording.bytes || 0) > 0 &&
    ["uploading", "sharing", "failed"].includes(
      recording.recording_sessions?.status,
    )
  );
}

export default function BrowserTabletsAdmin() {
  const [data, setData] = useState<any>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [selected, setSelected] = useState<any>(null),
    [removing, setRemoving] = useState<any>(null),
    [cancellingUpload, setCancellingUpload] = useState<any>(null),
    [showEnrollmentModal, setShowEnrollmentModal] = useState(false);
  const [mode, setMode] = useState("browser");
  const [newTabletVersion, setNewTabletVersion] = useState(0);
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
      const d = await r.json();
      if (!r.ok) throw Error(d.error);
      setData(d);
      return d;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, []);
  async function action(body: object) {
    setBusy(true);
    setError("");
    setCode("");
    try {
      const r = await fetch("/api/admin/tablets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error);
      if (d.code) {
        setCode(d.code);
        setShowEnrollmentModal(true);
      }
      const password = tabletEditor.current?.querySelector<HTMLInputElement>(
        'input[name="rtsp_password"]',
      );
      if (password) password.value = "";
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
  const canRetrySelectedUpload = canContinueUpload(selectedRecording);
  return (
    <section className="admin-card browser-devices">
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
            setMode("browser");
            setCode("");
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
            const recording = data.recordings.find(
              (r: any) => r.device_id === d.id,
            );
            const deviceQueue = data.recordings.filter(
              (r: any) => r.device_id === d.id,
            );
            const queueSummary = (status: string) =>
              deviceQueue.filter((r: any) => r.upload_state === status).length;
            const activeQueueCount =
              queueSummary("pending") + queueSummary("retrying");
            const queueItems = deviceQueue.filter((item: any) =>
              ["saved_locally", "pending", "retrying", "uploading", "failed"].includes(
                item.upload_state,
              ),
            );
            const visibleQueue = queueItems.slice(0, 4);
            const online =
              d.enabled &&
              d.kiosk_id &&
              Date.now() - Date.parse(d.last_seen_at || "") < 45000;
            const deviceStatus = !d.enabled
              ? "Disabled"
              : !d.kiosk_id
                ? "Awaiting enrollment"
                : online
                  ? "Online"
                  : "Offline";
            const uploadPercent = recording?.bytes
              ? Math.min(
                  100,
                  Math.round(
                    (Number(recording.uploaded_bytes || 0) /
                      Number(recording.bytes)) *
                      100,
                  ),
                )
              : 0;
            const uploadVisible =
              recording &&
              recording.recording_sessions?.status !== "ready" &&
              [
                "queued",
                "saved_locally",
                "pending",
                "retrying",
                "uploading",
                "failed",
                "cancelled",
                "local_only",
              ].includes(recording.upload_state);
            const canContinue = canContinueUpload(recording);
            const readyFile = recording?.recording_sessions?.recording_files?.find(
              (file: any) => file.status === "ready" && file.drive_file_id,
            );
            const emailStatus = readyFile?.email_jobs?.status;
            const selectDevice = () => {
              setSelected(d);
              setMode(
                d.recorder_mode === "android_rtsp" &&
                  d.video_device === "android-camera-v1"
                  ? "android_camera"
                  : d.recorder_mode || "browser",
              );
              setCode("");
            };
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
                  <span className={`device-status-pill ${online ? "online" : ""}`}>
                    {online && <span className="device-online-dot" aria-hidden="true" />}
                    {deviceStatus}
                  </span>
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
                  {recording ? ` · ${recording.upload_state === "failed" ? "needs attention" : recording.recording_sessions.status}` : ""}
                </small>
                <span className="device-queue-overview">
                  <strong>Upload queue</strong>
                  <span>{queueSummary("saved_locally")} saved</span>
                  <span>{activeQueueCount} pending</span>
                  <span>{queueSummary("uploading")} uploading</span>
                  <span>{queueSummary("failed")} failed</span>
                </span>
                {visibleQueue.length > 0 && (
                  <span className="device-queue-items" aria-label={`${d.name} upload items`}>
                    {visibleQueue.map((item: any) => {
                      const percent = item.bytes
                        ? Math.min(
                            100,
                            Math.round(
                              (Number(item.uploaded_bytes || 0) / Number(item.bytes)) * 100,
                            ),
                          )
                        : 0;
                      return (
                        <span className="device-queue-item" key={item.job_id || item.session_id}>
                          <span>Video {item.session_id?.slice(0, 8)}</span>
                          <span>
                            {item.upload_state.replaceAll("_", " ")}
                            {item.upload_state === "uploading" ? ` · ${percent}%` : ""}
                          </span>
                        </span>
                      );
                    })}
                    {queueItems.length > visibleQueue.length && (
                      <span className="device-queue-more">
                        +{queueItems.length - visibleQueue.length} more in this device queue
                      </span>
                    )}
                  </span>
                )}
                {uploadVisible && (
                  <span className="device-upload-status">
                    <span>
                      <strong>
                        {recording.upload_state === "uploading"
                          ? `Uploading to Google Drive · ${uploadPercent}%`
                          : recording.upload_state === "failed"
                            ? recording.safe_error || (canContinue
                              ? "Upload paused"
                              : "Upload paused · check the original device")
                            : recording.upload_state === "cancelled"
                              ? "Upload cancelled · recover on this device"
                              : recording.upload_state === "local_only"
                                ? recording.recording_sessions.failure_stage ===
                                  "unsupported_format"
                                  ? "Local only · older WebM clip"
                                  : "Local only · clip under one minute"
                              : recording.upload_state === "retrying"
                                ? "Connection interrupted · retrying automatically"
                            : "Waiting in the upload queue"}
                      </strong>
                      <small>
                        {recording.upload_state === "local_only"
                          ? "This clip will not be sent to Google Drive."
                          : "The original webpage or APK keeps the local backup until it verifies that the upload completed."}
                      </small>
                      {canContinue && (
                        <button
                          type="button"
                          className="device-continue-upload"
                          disabled={busy}
                          onClick={(event) => {
                            event.stopPropagation();
                            void action({
                              action: "retry-upload",
                              id: d.id,
                              session_id: recording.session_id,
                            });
                          }}
                        >
                          {busy ? "Requesting…" : "Continue upload"}
                        </button>
                      )}
                    </span>
                    <span
                      className="device-upload-meter"
                      role="progressbar"
                      aria-label={`${d.name} upload progress`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={uploadPercent}
                    >
                      <i style={{ width: `${uploadPercent}%` }} />
                    </span>
                  </span>
                )}
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
                Use Add device to choose a directly connected camera, the
                Android device camera, or an external Wi-Fi camera.
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
              recorder_mode: mode,
              camera_name: f.get("camera_name"),
              rtsp_host: f.get("rtsp_host"),
              rtsp_username: f.get("rtsp_username"),
              rtsp_password: f.get("rtsp_password"),
            });
          }}
        >
          <div className="tablet-editor-heading">
            <div>
              <h3>{selected ? "Edit device" : "Add device"}</h3>
              <p>
                {selected
                  ? "Update its type, name, court, and camera connection."
                  : "Choose a tablet or camera, assign its court, then enroll the physical device."}
              </p>
            </div>
            <span className="status-tag">
              {selected ? "Editing" : "New device"}
            </span>
          </div>
          <fieldset className="tablet-fields" disabled={busy || loading}>
            <label>
              <span>Recording setup</span>
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="browser">
                  Wired USB / built-in camera · Browser
                </option>
                <option value="android_camera">
                  Android camera only · APK (no Tapo)
                </option>
                <option value="android_rtsp">
                  Wi-Fi Tapo camera · Android gateway
                </option>
              </select>
              <small>
                Direct mode records a wired USB camera or the browser device’s built-in camera.
                Wi-Fi mode records the external Tapo/RTSP camera; the Android
                APK acts only as its network recorder and uploader.
              </small>
            </label>
            <label>
              <span>Device name</span>
              <input
                name="name"
                required
                maxLength={100}
                defaultValue={selected?.name || ""}
                placeholder={mode === "browser" ? "Example: Court 1 Tablet" : "Example: Court 1 Android"}
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
            {mode === "android_camera" && (
              <>
                <h3>Android camera</h3>
                <div className="automatic-audio-note">
                  <strong>Uses this Android device</strong>
                  <span>
                    The APK records with the rear camera and built-in microphone.
                    No external camera or camera IP address is required.
                  </span>
                </div>
                <details className="tapo-guide">
                  <summary>Android device camera setup guide</summary>
                  <ol>
                    <li>Install and open the Dink Vision Recorder APK on the Android device.</li>
                    <li>Open Device setup and enter the one-time enrollment code.</li>
                    <li>Allow camera, microphone, and notification permissions when asked.</li>
                    <li>Keep the Android device mounted, charging, awake, and aimed at its assigned court.</li>
                  </ol>
                </details>
              </>
            )}
            {mode === "android_rtsp" && (
              <>
                <h3>External Wi-Fi camera</h3>
                <div className="automatic-audio-note">
                  <strong>Uses the Tapo camera—not the Android camera</strong>
                  <span>
                    The Android APK is the gateway: it receives the Tapo RTSP
                    stream over the local network, saves it, and uploads it.
                    The Android camera and microphone are not used in this mode.
                  </span>
                </div>
                <label>
                  Camera name
                  <input
                    name="camera_name"
                    required
                    maxLength={100}
                    defaultValue={selected?.camera_name || ""}
                    placeholder="Tapo C210"
                  />
                </label>
                <label>
                  RTSP address
                  <span className="rtsp-address-field">
                    <span>rtsp://</span>
                    <input
                      name="rtsp_host"
                      required
                      maxLength={15}
                      inputMode="decimal"
                      defaultValue={cameraIp(selected?.rtsp_url)}
                      placeholder="192.168.100.210"
                      autoComplete="off"
                      aria-label="Camera IP address"
                    />
                    <span>:554/stream1</span>
                  </span>
                  <small>Enter only the camera IP address. The RTSP address is completed automatically.</small>
                </label>
                <label>
                  Camera Account username
                  <input
                    name="rtsp_username"
                    required
                    maxLength={100}
                    defaultValue={selected?.rtsp_username || ""}
                    autoComplete="off"
                  />
                </label>
                <label>
                  Camera Account password
                  <input
                    name="rtsp_password"
                    type="password"
                    required={!selected?.has_camera_password}
                    maxLength={256}
                    autoComplete="new-password"
                    placeholder={
                      selected?.has_camera_password
                        ? "Saved — leave blank to keep it"
                        : "Camera Account password"
                    }
                  />
                </label>
                <div className="automatic-audio-note">
                  <strong>Camera audio is automatic</strong>
                  <span>If the Wi-Fi camera provides a microphone track, it is included in every recording.</span>
                </div>
                <p className="form-note">
                  The enrolled Android gateway connects to and tests the
                  external camera on the same local network.
                </p>
                <details className="tapo-guide">
                  <summary>Tapo C210 setup guide</summary>
                  <ol>
                    <li>In the Tapo app, open the C210 and go to Device Settings → Advanced Settings → Camera Account. Create a camera username and password.</li>
                    <li>Open Network Settings in the Tapo app or your router and copy the camera’s IP address, such as <code>192.168.1.100</code>.</li>
                    <li>Use a clear camera name such as <strong>Court 1 Tapo C210</strong>. Enter only the IP above; this page builds <code>rtsp://IP:554/stream1</code>.</li>
                    <li>Keep the Android gateway and Tapo camera on the same Wi-Fi. The Android device does not need to face the court; after enrollment, it checks the Tapo video and available Tapo microphone audio automatically.</li>
                  </ol>
                </details>
              </>
            )}
          </fieldset>
          {selected && (
            <div className="tablet-device-details">
              <span>Device ID</span>
              <code>{selected.id}</code>
              <p>
                {selected.diagnostic ||
                  (mode !== "browser"
                    ? "Settings are sent securely to the enrolled Android tablet."
                    : "Camera settings and permissions are configured on the physical tablet.")}
              </p>
            </div>
          )}
          <div className="tablet-primary-action">
            <button className="primary" disabled={busy || loading}>
              {selected ? "Save changes" : "Create enrollment code"}
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
                  Re-enabling creates a fresh one-time code. Enter it on the
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
                {busy ? "Re-enabling…" : "Re-enable device & get code"}
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
                  Release the venue queue without deleting the video saved on
                  this device. It can be retried later from the original device.
                </p>
              </div>
              <div className="save-row">
                {canRetrySelectedUpload && (
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
                    {busy ? "Requesting…" : "Continue upload"}
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
                <strong>Remove device</strong>
                <p>Permanently disconnect and remove this device. Recording logs and uploaded videos are kept.</p>
              </div>
              <button
                type="button"
                className="remove-device-button"
                disabled={busy}
                onClick={() => setRemoving(selected)}
              >
                <Trash2 size={16} />
                Remove device
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
                Choose a direct wired/built-in camera, the Android device’s own
                camera, or an external Tapo/Wi-Fi camera; then assign a court.
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
              <p>Direct browser cameras review a short test clip. For external Wi-Fi mode, the Android gateway tests the saved Tapo/RTSP stream without using its own camera.</p>
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
              This releases the queue so the next video can upload. The video
              is not deleted: it stays on the original device and can rejoin
              the end of the queue with Recover / retry upload.
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
                {busy ? "Cancelling…" : "Cancel upload & release queue"}
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
            <h2 id="remove-device-title">Remove {removing.name}?</h2>
            <p id="remove-device-description">
              This permanently removes the device and disconnects its enrollment. Existing recording logs and uploaded videos stay available, but unsent footage on the removed device may no longer be recoverable.
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
                  void action({ action: "remove", id: removing.id }).then(
                    (removed) => {
                      if (!removed) return;
                      setRemoving(null);
                      setSelected(null);
                    },
                  );
                }}
              >
                {busy ? "Removing…" : "Remove permanently"}
              </button>
            </div>
          </section>
        </div>
      )}
      {code && showEnrollmentModal && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowEnrollmentModal(false);
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
            <p id="enroll-desc">
              {mode !== "browser"
                ? "Open Device setup in the Android app and enter this code. The selected camera will be tested automatically."
                : "Open this website on the tablet, visit /tablet/setup, and enter this code."}{" "}
              Single use · expires in 10 minutes.
            </p>
            <code className="enrollment-code">{code}</code>
            <p>
              Replacing enrollment disconnects the old device after the code is
              used.
            </p>
            <div className="confirm-modal-actions">
              <button
                type="button"
                className="sign-in"
                onClick={() => {
                  navigator.clipboard.writeText(code).catch(() => {});
                  setShowEnrollmentModal(false);
                }}
              >
                Copy code
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => setShowEnrollmentModal(false)}
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
