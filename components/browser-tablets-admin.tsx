"use client";
import {RecorderTimeline} from "@/components/recorder-timeline";
import { EnrollmentInvitation, enrollmentQrFromResponse, reserveEnrollmentTab, showEnrollmentTab, type EnrollmentQr } from "@/components/admin-enrollment-qr";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Camera, ChevronRight, CloudUpload, Monitor, Plus, QrCode, RefreshCw, Search, Settings2, Smartphone, Trash2, TriangleAlert, Wifi } from "lucide-react";
import { recordingIsConfirmed } from "@/lib/recording-status";
import { devicePresence } from "@/lib/device-presence";
import AdminDeviceQueue, { formatDeviceTime, uploadCounts } from "@/components/admin-device-queue";
import { AdminSkeleton, SkeletonBlock, SkeletonRows } from "@/components/admin-skeleton";
import type { AdminDevice, AdminDevicesData, DeviceRecording } from "./admin-device-types";

type AdminTabletAction = {action: string; id?: string; [key: string]: unknown};

export default function BrowserTabletsAdmin() {
  const [data, setData] = useState<AdminDevicesData | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [qrEnrollment, setQrEnrollment] = useState<EnrollmentQr | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [removing, setRemoving] = useState<AdminDevice | null>(null),
    [cancellingUpload, setCancellingUpload] = useState<{device: AdminDevice; recording: DeviceRecording} | null>(null);
  const [panel, setPanel] = useState<"overview" | "create" | "manage">("overview");
  const [search, setSearch] = useState("");
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [newTabletVersion, setNewTabletVersion] = useState(0);
  const [connectionNotice, setConnectionNotice] = useState("");
  const [replacingEnrollment,setReplacingEnrollment]=useState<AdminTabletAction|null>(null);
  const tabletEditor = useRef<HTMLFormElement>(null);
  const detailPanel = useRef<HTMLElement>(null);
  const refreshSequence = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
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
    const request = ++refreshSequence.current;
    try {
      const r = await fetch("/api/admin/tablets", { cache: "no-store", signal: AbortSignal.timeout(12000) });
      const d = await r.json();
      if (!r.ok) throw Error(d.error || "Device status is unavailable.");
      if (request !== refreshSequence.current) return;
      setConnectionNotice("");
      setData({...d,receivedAt:Date.now()});
      return d;
    } catch (e) {
      if (request !== refreshSequence.current) return;
      setConnectionNotice(navigator.onLine
        ? e instanceof TypeError || e instanceof DOMException
          ? "Could not refresh device status. Showing the last report while we reconnect."
          : (e as Error).message
        : "You’re offline. Device information may be out of date.");
    } finally {
      if (request === refreshSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    let stopped = false;
    let polling = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void poll(), delay);
    };
    async function poll() {
      if (stopped || polling || document.hidden) return;
      polling = true;
      await refresh();
      polling = false;
      if (!stopped && !document.hidden) schedule(15000);
    }
    const onVisible = () => { clearTimeout(timer); if (!document.hidden) void poll(); };
    void poll();
    const offline = () => setConnectionNotice("No internet connection detected. Displayed device states may be stale.");
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", onVisible);
    return () => { stopped = true; ++refreshSequence.current; clearTimeout(timer); window.removeEventListener("offline", offline); document.removeEventListener("visibilitychange", onVisible); };
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
      if (body.action === "save") {
        if (d.id || body.id) setSelectedId(d.id || body.id);
        setPanel("overview");
        setNotice(body.id ? "Device settings saved." : "Device added. Scan the pairing QR on the recorder.");
      }
      if (body.action === "disable") setNotice("Device disabled.");
      await refresh();
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
  const devices = data?.devices || [];
  const courts = data?.courts || [];
  const selected = devices.find(device => device.id === selectedId) || devices[0] || null;
  const editing = panel === "manage" ? selected : null;
  const showEditor = panel !== "overview" || (!!data && devices.length === 0);
  const zone = data?.timeZone;
  const now = (Date.parse(data?.serverTime || "") || data?.receivedAt || Date.now())
    + (data?.receivedAt ? Math.max(0, Date.now() - data.receivedAt) : 0);
  const recordingsByDevice = new Map<string, DeviceRecording[]>();
  for (const recording of data?.recordings || []) {
    const list = recordingsByDevice.get(recording.device_id) || [];
    list.push(recording);
    recordingsByDevice.set(recording.device_id, list);
  }
  const counts = uploadCounts(data?.recordings || []);
  const directory = devices.map(device => {
    const court = courts.find(item => item.id === device.court_id)?.name || "Unassigned";
    const presence = devicePresence(device, now);
    const failed = uploadCounts(recordingsByDevice.get(device.id) || []).failed;
    return { device, court, presence, failed, attention: device.enabled && (!presence.connected || !device.tested_at || failed > 0) };
  });
  const query = search.trim().toLowerCase();
  const filtered = directory.filter(entry =>
    (!onlyAttention || entry.attention) &&
    (!query || [entry.device.name, entry.court, entry.device.device_info?.model, entry.device.camera_name,
      ...(entry.device.device_info?.usb_cameras || []).map(camera => camera.name)].some(value => value?.toLowerCase().includes(query)))
  );
  const selectedEntry = directory.find(entry => entry.device.id === selected?.id);
  const selectedRows = selected ? recordingsByDevice.get(selected.id) || [] : [];
  const capture = selectedRows.find(row => row.recording_sessions?.status === "recording");
  const confirmedCapture = capture?.recording_sessions?.status === "recording" && recordingIsConfirmed({
    status: capture.recording_sessions.status,
    started_at: capture.recording_sessions.started_at || null,
    duration_seconds: capture.recording_sessions.duration_seconds,
  }, { session_id: capture.session_id, last_seen_at: capture.last_seen_at || null }, now);
  const availableCourts = courts.filter(court => court.id === editing?.court_id ||
    (court.active && !devices.some(device => device.id !== editing?.id && device.court_id === court.id)));
  const hiddenCourtCount = courts.filter(court => court.active).length - availableCourts.filter(court => court.active).length;
  const hardware = selected?.device_info;
  const native = selected?.recorder_mode === "android_rtsp" || !!hardware;
  function openDevice(id: string) {
    setSelectedId(id);
    setPanel("overview");
    setError("");
    if (window.matchMedia("(max-width: 760px)").matches) {
      requestAnimationFrame(() => detailPanel.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
    }
  }
  return (
    <section className="admin-card browser-devices recorder-workspace" aria-labelledby="recorder-workspace-title">
      <header className="recorder-workspace-header">
        <div>
          <h2 id="recorder-workspace-title">Devices &amp; cameras</h2>
          <p>Check a court recorder, review its camera setup, or manage its uploads.</p>
          {data?.serverTime && <p>{connectionNotice ? "Last successful refresh" : "Last refreshed"} · {formatDeviceTime(data.serverTime, zone)}</p>}
        </div>
        <div className="recorder-workspace-actions">
          <button className="secondary" type="button" disabled={refreshing || loading} onClick={async () => {
            setRefreshing(true);
            try { await refresh(); } finally { setRefreshing(false); }
          }}><RefreshCw size={16} aria-hidden="true" /> {refreshing ? "Refreshing…" : "Refresh"}</button>
          <button className="primary" type="button" disabled={busy || loading} onClick={() => {
            setPanel("create"); setError(""); setNewTabletVersion(version => version + 1);
          }}><Plus size={18} aria-hidden="true" /> Add device</button>
        </div>
      </header>
      {connectionNotice && <p role="status" className="recorder-alert"><TriangleAlert size={17} aria-hidden="true" />{connectionNotice}</p>}
      {notice && <p role="status" className="recorder-alert is-success">{notice}</p>}
      {error && <p role="alert" className="recorder-alert is-danger">{error}</p>}
      {data && <dl className="recorder-overview-stats" aria-label="Recorder status overview">
        <div><dt><Wifi size={16} aria-hidden="true" /> Connected</dt><dd>{directory.filter(entry => entry.presence.connected).length}<span> / {devices.length} devices</span></dd></div>
        <div><dt><Camera size={16} aria-hidden="true" /> Camera checks due</dt><dd>{devices.filter(device => device.enabled && device.kiosk_id && !device.tested_at).length}</dd></div>
        <div><dt><CloudUpload size={16} aria-hidden="true" /> Uploads in progress</dt><dd>{counts.uploading}<span> · {counts.waiting} waiting</span></dd></div>
        <div><dt><TriangleAlert size={16} aria-hidden="true" /> Failed uploads</dt><dd>{counts.failed}</dd></div>
      </dl>}
      <div className="recorder-workspace-grid">
        <section className="recorder-directory" aria-busy={loading} aria-label="Registered devices">
          <div className="recorder-directory-heading"><h3>Recorders</h3>{data && <span>{devices.length}</span>}</div>
          {loading && <AdminSkeleton label="Loading recorders"><SkeletonRows /></AdminSkeleton>}
          {!loading && !data && <p className="recorder-directory-empty">Select Refresh to try again.</p>}
          {!!devices.length && <>
            <label className="recorder-search"><Search size={16} aria-hidden="true" />
              <input type="search" aria-label="Find a recorder" placeholder="Find a recorder or court" value={search} onChange={event => setSearch(event.target.value)} />
            </label>
            <label className="recorder-attention-filter">
              <input type="checkbox" checked={onlyAttention} onChange={event => setOnlyAttention(event.target.checked)} /> Needs attention only
            </label>
            <ul className="recorder-directory-list">
              {filtered.map(({ device, court, presence, failed }) => {
                const active = panel !== "create" && selected?.id === device.id;
                const Icon = device.recorder_mode === "android_rtsp" || device.device_info ? Smartphone : Monitor;
                return <li key={device.id}>
                  <button type="button" aria-pressed={active} aria-controls="recorder-device-panel"
                    className={`recorder-directory-item ${active ? "is-selected" : ""}`} onClick={() => openDevice(device.id)}>
                    <span className="recorder-directory-icon"><Icon size={21} aria-hidden="true" /></span>
                    <span className="recorder-directory-copy">
                      <strong>{device.name}</strong><span>{court}</span>
                      <span className="recorder-directory-status"><i className={presence.connected ? "is-connected" : ""} aria-hidden="true" />{presence.label}
                        {failed > 0 && <span className="recorder-directory-failed"> · {failed} failed</span>}
                      </span>
                    </span>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                </li>;
              })}
            </ul>
            {!filtered.length && <p className="recorder-directory-empty">No recorders match. Clear the search or filter to see all devices.</p>}
          </>}
          {!!data && !devices.length && <p className="recorder-directory-empty">No recorders registered. Add your first device to get a pairing QR.</p>}
        </section>
        <section className="recorder-device-panel" id="recorder-device-panel" ref={detailPanel} aria-label={showEditor ? editing ? "Manage device" : "Add device" : "Selected recorder"}>
          {!showEditor && !selected && (loading
            ? <div className="recorder-detail-content"><AdminSkeleton label="Loading recorder details">
                <SkeletonBlock className="is-heading" />
                <div className="recorder-facts-grid"><SkeletonBlock className="is-card" /><SkeletonBlock className="is-card" /></div>
                <SkeletonRows count={2} />
              </AdminSkeleton></div>
            : <p className="recorder-directory-empty">Recorder details will appear when the connection returns.</p>)}
          {!showEditor && selected && selectedEntry && <>
            <header className="recorder-device-header">
              <div className="recorder-device-title">
                <div className="recorder-device-kind">{native ? <Smartphone size={16} aria-hidden="true" /> : <Monitor size={16} aria-hidden="true" />}
                  {native ? "Android recorder" : "Recorder"} <span>·</span> {selectedEntry.court}</div>
                <h3>{selected.name}</h3>
                <div className="recorder-device-statuses">
                  <span className={`recorder-state ${selectedEntry.presence.connected ? "is-success" : selected.enabled ? "is-warning" : ""}`}>{selectedEntry.presence.label}</span>
                  {selected.enabled && selected.kiosk_id && <span className={`recorder-state ${selected.tested_at ? "is-success" : "is-warning"}`}>{selected.tested_at ? "Camera tested" : "Camera check needed"}</span>}
                  {capture && <span className={`recorder-state ${confirmedCapture ? "is-live" : "is-warning"}`}>{confirmedCapture ? "Recording now" : "Recording unconfirmed"}</span>}
                </div>
              </div>
              <button className="secondary recorder-manage-button" type="button" disabled={busy} onClick={() => {
                setPanel("manage"); setError("");
              }}><Settings2 size={17} aria-hidden="true" /> Manage device</button>
            </header>
            <div className="recorder-detail-content">
              <div className="recorder-facts-grid">
                <section className="recorder-facts">
                  <h4><Camera size={18} aria-hidden="true" /> Camera &amp; audio</h4>
                  <dl>
                    <dt>Camera setup</dt><dd>{selected.camera_name || "Not selected"}</dd>
                    {native && <><dt>Attached USB camera</dt><dd>{hardware?.usb_cameras?.map(camera => camera.name).join(", ") || "None reported"}</dd></>}
                    <dt>Last camera test</dt><dd>{formatDeviceTime(selected.tested_at, zone) || "No successful test reported"}</dd>
                    {native && <>
                      <dt>Microphone</dt><dd>{hardware?.microphone_input || "Not reported"}</dd>
                      <dt>Recording mode</dt><dd>{hardware?.recording_profile || "Not reported"}</dd>
                    </>}
                  </dl>
                  {selected.enabled && selected.kiosk_id && (!selected.tested_at || (native && !hardware?.recording_profile)) &&
                    <p>Run the camera check in Device setup on this recorder to verify its picture and sound.</p>}
                </section>
                <section className="recorder-facts">
                  <h4>{native ? <Smartphone size={18} aria-hidden="true" /> : <Monitor size={18} aria-hidden="true" />} Device details</h4>
                  <dl>
                    <dt>Last contact</dt><dd>{formatDeviceTime(selected.last_seen_at, zone) || "No contact reported"}</dd>
                    {hardware && <>
                      <dt>Model</dt><dd>{hardware.manufacturer} {hardware.model}</dd>
                      <dt>Android</dt><dd>{hardware.android_version} · API {hardware.android_sdk}</dd>
                      <dt>APK version</dt><dd>{hardware.app_version} · build {hardware.app_version_code}</dd>
                      <dt>Hardware report</dt><dd>{formatDeviceTime(hardware.reported_at, zone) || "Time unavailable"}</dd>
                    </>}
                  </dl>
                  {!selected.kiosk_id && selected.enabled && <p>Create or reopen the pairing invitation from Manage device.</p>}
                  <div className="recorder-diagnostics"><RecorderTimeline key={selected.id} deviceId={selected.id} /></div>
                </section>
              </div>
              <AdminDeviceQueue device={selected} recordings={selectedRows} zone={zone} now={now} busy={busy}
                onRetry={id => void action({ action: "retry-upload", id: selected.id, session_id: id }).then(ok => {
                  if (ok) setNotice("Retry requested. The recorder will continue when it connects.");
                })}
                onCancel={recording => setCancellingUpload({ device: selected, recording })}
                onRetryEmail={id => void retryEmail(id)} />
            </div>
          </>}
          {showEditor && <div className="recorder-detail-content recorder-editor-content">
            {!!devices.length && <button className="recorder-text-action" type="button" disabled={busy} onClick={() => {
              setPanel("overview"); setError("");
            }}><ArrowLeft size={16} aria-hidden="true" /> Back to recorder overview</button>}
        <form
          ref={tabletEditor}
          key={`${editing?.id || "new"}-${newTabletVersion}`}
          className="stack-form tablet-editor"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void action({
              action: "save",
              id: editing?.id,
              name: f.get("name"),
              court_id: f.get("court_id"),
            });
          }}
        >
          <header className="device-editor-header">
            <div>
              {editing && <div className="recorder-device-kind"><Settings2 size={16} aria-hidden="true" />{editing.name}</div>}
              <h3>{editing ? "Manage device" : "Add device"}</h3>
              <p>
                {editing
                  ? "Update its name or court. Camera selection stays on the physical device."
                  : "Name the device, assign its court, then enroll and select its camera on the physical device."}
              </p>
            </div>
            {editing && selectedEntry && <span className={`recorder-state ${selectedEntry.presence.connected ? "is-success" : editing.enabled ? "is-warning" : ""}`}>
              {selectedEntry.presence.label}
            </span>}
          </header>
          <fieldset className="tablet-fields device-editor-fields" disabled={busy || loading}>
            <legend>Device details</legend>
            <label>
              <span>Device name</span>
              <input
                name="name"
                required
                maxLength={100}
                defaultValue={editing?.name || ""}
                placeholder="Example: Court 1 Tablet"
              />
              <small>A clear name helps staff identify the physical device.</small>
            </label>
            <label>
              <span>Assigned court</span>
              <select name="court_id" defaultValue={editing?.court_id || ""}>
                <option value="">Unassigned</option>
                {availableCourts.map(court => (
                    <option key={court.id} value={court.id}>
                      {court.name}{court.active ? "" : " (inactive)"}
                    </option>
                  ))}
              </select>
              <small>
                {hiddenCourtCount
                  ? `${hiddenCourtCount} ${hiddenCourtCount === 1 ? "court is" : "courts are"} hidden because ${hiddenCourtCount === 1 ? "it is" : "they are"} already assigned.`
                  : "Only active, available courts are shown."}
              </small>
            </label>
          </fieldset>
          <div className="device-editor-save">
            <button className="primary" type="submit" disabled={busy || loading}>
              {editing ? "Save changes" : "Create pairing invitation"}
            </button>
          </div>
          <div className="device-editor-camera recorder-facts">
            <h4><Camera size={17} aria-hidden="true" /> Camera setup</h4>
            <p>Open Device setup in the DinkVision Android app to select and test the camera.</p>
          </div>
          {editing && editing.enabled && (
            <section className="device-editor-access recorder-facts">
              <div>
                <h4><QrCode size={17} aria-hidden="true" /> Pairing &amp; access</h4>
                <p>Create an invitation for this recorder or disable its access.</p>
              </div>
              <div className="save-row">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void action({
                      action: "enroll",
                      id: editing.id,
                      name: editing.name,
                      court_id: editing.court_id,
                    })
                  }
                >
                  New pairing invitation
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void action({ action: "disable", id: editing.id })
                  }
                >
                  Disable device
                </button>
              </div>
            </section>
          )}
          {editing && !editing.enabled && (
            <section className="device-editor-access recorder-facts">
              <div>
                <h4><QrCode size={17} aria-hidden="true" /> Re-enable this recorder</h4>
                <p>
                  Re-enabling creates a fresh one-time QR. Scan it on the
                  physical device to reconnect securely.
                </p>
              </div>
              <button
                type="button"
                className="secondary"
                disabled={busy || !editing.court_id}
                onClick={() =>
                  void action({
                    action: "enroll",
                    id: editing.id,
                    name: editing.name,
                    court_id: editing.court_id,
                  })
                }
              >
                {busy ? "Re-enabling…" : "Re-enable device & get QR"}
              </button>
              {!editing.court_id && (
                <p className="form-note">
                  Assign and save a court before re-enabling this device.
                </p>
              )}
            </section>
          )}
          {editing && (
            <>
              <details className="recorder-disclosure device-editor-technical">
                <summary>Technical details</summary>
                <p>Device ID <code>{editing.id}</code></p>
                {editing.diagnostic && <p>{editing.diagnostic}</p>}
              </details>
              <div className="device-danger-zone">
                <div>
                  <strong>Delete device</strong>
                  <p>Remove this device and its enrollment. Active recordings and uploads stop. Recording logs and uploaded videos stay available.</p>
                </div>
                <button
                  type="button"
                  className="remove-device-button"
                  disabled={busy}
                  onClick={() => setRemoving(editing)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                  Delete device
                </button>
              </div>
            </>
          )}
        </form>
          </div>}
        </section>
      </div>
      <details className="recorder-disclosure recorder-setup-guide">
        <summary>How to set up a recorder</summary>
        <ol>
          <li>Add a recorder and assign its court.</li>
          <li>Scan its pairing QR or enter its code in the DinkVision Android app.</li>
          <li>Run the camera check on that recorder to verify the picture and microphone.</li>
        </ol>
      </details>
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
                    session_id: cancellingUpload.recording.session_id,
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
                      setSelectedId(null);
                      setPanel("overview");
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
    </section>
  );
}
