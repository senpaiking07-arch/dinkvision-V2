"use client";
import { useAdminRealtime, type RealtimeScope } from "./use-admin-realtime";
import { AdminModal } from "./admin-modal";
import BrowserTabletsAdmin from "./browser-tablets-admin";
import StorageSmtpControls from "./storage-smtp-controls";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Camera as CameraIcon,
  LayoutGrid,
  Settings2,
  List,
  MapPin,
  ChevronRight,
  Wifi,
  Clock3,
  Plus,
  Trash2,
  Search,
} from "lucide-react";
import type { AdminData, Court } from "@/lib/admin-types";
import type { AdminDevice } from "@/components/admin-device-types";
import { devicePresence } from "@/lib/device-presence";
import { recordingIsConfirmed } from "@/lib/recording-status";
import { cameraHealth } from "@/lib/camera-health";
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, SECONDS_PER_DAY } from "@/lib/validation";
import { AdminSkeleton, SkeletonBlock } from "@/components/admin-skeleton";
import { RecordingLogRow, recordingLogStatus, recordingStatuses } from "@/components/admin-recording-log";

type Tab = "overview" | "courts" | "cameras" | "settings" | "logs";
function SaveForm({
  resource,
  children,
  convert,
  onSaved,
  secondaryAction,
}: {
  resource: string;
  children: ReactNode;
  convert: (form: FormData) => object;
  onSaved?: (id?: string) => void;
  secondaryAction?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const router = useRouter();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    setFailed(false);
    const body = convert(new FormData(e.currentTarget));
    try {
      const response = await fetch(`/api/admin/${resource}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) {
        setMessage(result.error || "Unable to save.");
        setFailed(true);
      } else {
        setMessage("Saved successfully.");
        router.refresh();
        onSaved?.(typeof result.id === "string" ? result.id : undefined);
      }
    } catch {
      setMessage(
        "Could not reach the server. Your changes have not been saved.",
      );
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="stack-form" onSubmit={submit}>
      <fieldset disabled={busy}>{children}</fieldset>
      <div className="save-row">
        <button className="primary" disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
        {secondaryAction}
        {message && (
          <p
            role={failed ? "alert" : "status"}
            className={failed ? "form-error" : "save-success"}
          >
            {message}
          </p>
        )}
      </div>
    </form>
  );
}

function CourtForm({
  court,
  onSaved,
  onRemoved,
}: {
  court?: Court;
  onSaved: (id?: string) => void;
  onRemoved: () => void;
}) {
  const [updating, setUpdating] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [statusFailed, setStatusFailed] = useState(false);
  const router = useRouter();

  async function removeCourt() {
    if (!court) return;
    setUpdating(true);
    setStatusMessage("");
    setStatusFailed(false);
    try {
      const response = await fetch("/api/admin/courts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: court.id }),
      });
      const result = await response.json();
      if (!response.ok) {
        setStatusMessage(
          result.error || "Unable to permanently remove this court.",
        );
        setStatusFailed(true);
        return;
      }
      setConfirmingRemove(false);
      setStatusMessage("Court permanently removed.");
      onRemoved();
      router.refresh();
    } catch {
      setStatusMessage(
        "Could not reach the server. This court was not removed.",
      );
      setStatusFailed(true);
    } finally {
      setUpdating(false);
    }
  }

  return (
    <>
      <SaveForm
        resource="courts"
        onSaved={onSaved}
        convert={(f) => ({
          id: court?.id,
          name: f.get("name"),
          location: f.get("location"),
          active: court?.active ?? true,
        })}
        secondaryAction={
          court ? (
            <button
              type="button"
              className="remove-court-button"
              disabled={updating}
              onClick={() => {
                setStatusMessage("");
                setConfirmingRemove(true);
              }}
            >
              <Trash2 size={15} /> Remove court
            </button>
          ) : undefined
        }
      >
        <label>
          Court name
          <input
            name="name"
            defaultValue={court?.name}
            placeholder="Court 01"
            required
            maxLength={100}
          />
        </label>
        <label>
          Location or description
          <input
            name="location"
            defaultValue={court?.location}
            placeholder="Garden side"
            maxLength={150}
          />
        </label>
        {statusMessage && (
          <p
            role={statusFailed ? "alert" : "status"}
            className={statusFailed ? "form-error" : "save-success"}
          >
            {statusMessage}
          </p>
        )}
      </SaveForm>
      {confirmingRemove && court && (
        <AdminModal
          title={`Remove ${court.name}?`}
          description="This permanently deletes the court and removes it from assigned devices. Existing videos and recording logs are kept. This cannot be undone."
          icon={Trash2}
          tone="danger"
          busy={updating}
          onDismiss={() => setConfirmingRemove(false)}
        >
          {statusFailed && statusMessage && (
            <p role="alert" className="form-error">
              {statusMessage}
            </p>
          )}
          <div className="admin-modal-actions">
            <button
              type="button"
              className="sign-in"
              disabled={updating}
              onClick={() => setConfirmingRemove(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="remove-court-button remove-court-button-solid"
              disabled={updating}
              onClick={() => void removeCourt()}
            >
              <Trash2 size={15} />
              {updating ? "Removing…" : "Remove court"}
            </button>
          </div>
        </AdminModal>
      )}
    </>
  );
}

export default function AdminDashboard({ data: initialData, initialRecordingId = "", realtimeScope }: {
  data: Pick<AdminData, "courts" | "settings" | "sessions" | "captureReports">;
  initialRecordingId?: string;
  realtimeScope?: RealtimeScope;
}) {
  const [tab, setTab] = useState<Tab>(initialRecordingId ? "logs" : "overview");
  const [courtId, setCourtId] = useState<string | null>(null);
  const [newCourtVersion, setNewCourtVersion] = useState(0);
  const courtEditor = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!newCourtVersion) return;
    courtEditor.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    courtEditor.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus({ preventScroll: true });
  }, [newCourtVersion]);
  const [tablets, setTablets] = useState<AdminDevice[] | null>(null);
  const [deviceStatusError, setDeviceStatusError] = useState(false);
  const [courtSearch, setCourtSearch] = useState("");
  useEffect(() => {
    if (tab === "cameras" || tab === "settings") return;
    const lifetime = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let loadingDevices = false;
    const schedule = (delay: number) => { clearTimeout(timer); timer = setTimeout(() => void load(), delay); };
    async function load() {
      if (loadingDevices || lifetime.signal.aborted || document.hidden) return;
      loadingDevices = true;
      try {
        const response = await fetch("/api/admin/tablets?summary=1", {
          cache: "no-store",
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(12000)]),
        });
        if (!response.ok) throw Error("Device status unavailable");
        const result = await response.json();
        if (lifetime.signal.aborted) return;
        setTablets(result.devices || []);
        setDeviceStatusError(false);
      } catch {
        if (!lifetime.signal.aborted) setDeviceStatusError(true);
      } finally {
        loadingDevices = false;
        if (!lifetime.signal.aborted && !document.hidden) schedule(30000);
      }
    }
    const onVisible = () => { clearTimeout(timer); if (!document.hidden) void load(); };
    void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => { lifetime.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [tab]);
  const [search, setSearch] = useState(initialRecordingId);
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("");
  const [logPage, setLogPage] = useState(1);
  const router = useRouter();
  const onAccessChanged = useCallback(() => router.refresh(), [router]);
  const { data, stale, accessLost } = useAdminRealtime(initialData, realtimeScope, initialRecordingId, onAccessChanged);
  useEffect(() => {
    if (realtimeScope) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(refreshWhenVisible, delay);
    };
    const refreshWhenVisible = () => {
      if (!active) return;
      clearTimeout(timer);
      if (document.hidden) return;
      router.refresh();
      schedule(30000);
    };
    schedule(30000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [router, realtimeScope]);
  const zone = data.settings.venue_time_zone || "UTC";
  function timestamp(value: string) {
    return new Intl.DateTimeFormat("en", {
      timeZone: zone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }
  function localDate(value: string) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(value));
  }
  function recordingCourtName(session: AdminData["sessions"][number]) {
    return (
      data.courts.find((court) => court.id === session.court_id)?.name ||
      session.configuration_snapshot?.court_name ||
      "Deleted court"
    );
  }
  function recordingRecipients(session: AdminData["sessions"][number]) {
    const recipients = session.configuration_snapshot?.recipient_emails;
    return Array.isArray(recipients) && recipients.length
      ? recipients.join(", ")
      : session.recipient_email;
  }
  const filtered = data.sessions.filter(
    (session) =>
      (!status || recordingLogStatus(session) === status) &&
      (!date || localDate(session.created_at) === date) &&
      `${recordingRecipients(session)} ${recordingCourtName(session)} ${session.id}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(logPage, pageCount);
  const pageStart = (currentPage - 1) * pageSize;
  const pageSessions = filtered.slice(pageStart, pageStart + pageSize);
  useEffect(() => {
    setLogPage((page) => Math.min(page, pageCount));
  }, [pageCount]);
  function resetFilters() {
    setSearch(""); setStatus(""); setDate(""); setLogPage(1);
  }
  const activeCourts = data.courts.filter((court) => court.active);
  const pendingCaptures = data.sessions.filter(session => session.status === "recording");
  const confirmed = (session: AdminData["sessions"][number]) => recordingIsConfirmed(
    session, data.captureReports?.find(report => report.session_id === session.id), Date.now());
  const unconfirmed = pendingCaptures.filter(session => !confirmed(session));
  const recordingCourtIds = new Set(pendingCaptures.filter(confirmed).map(session => session.court_id));
  const recordingCourts = activeCourts.filter((court) =>
    recordingCourtIds.has(court.id),
  );
  const now = Date.now();
  const connectedTablets = tablets?.filter(device => devicePresence(device, now).connected);
  const readyCameras = tablets?.filter(device => cameraHealth(device, devicePresence(device, now), now).state === "ready").length;
  const courtQuery = courtSearch.trim().toLowerCase();
  const visibleCourts = [...activeCourts, ...data.courts.filter(court => !court.active)]
    .filter(court => `${court.name} ${court.location || ""}`.toLowerCase().includes(courtQuery));
  const currentCourt = courtId === null ? activeCourts[0] || data.courts[0] : data.courts.find(court => court.id === courtId);
  const assigned = currentCourt && tablets?.find(device => device.court_id === currentCourt.id);
  const presence = assigned && devicePresence(assigned, now);
  const courtState = (court: Court) => unconfirmed.some(session => session.court_id === court.id)
    ? { label: "Recording unconfirmed", tone: "is-warning" }
    : recordingCourtIds.has(court.id) ? { label: "Recording now", tone: "is-live" }
      : court.active ? { label: "Active", tone: "is-success" } : { label: "Inactive", tone: "" };
  const overviewStatuses = [
    { label: "Active courts", icon: LayoutGrid, value: activeCourts.length, tab: "courts" },
    { label: "Connected recorders", icon: Wifi, value: connectedTablets?.length, tab: "cameras" },
    { label: "Cameras ready", icon: CameraIcon, value: readyCameras, tab: "cameras" },
    { label: "Recent recordings", icon: List, value: data.sessions.length, tab: "logs" },
  ] as const;
  const nav = [
    { id: "overview", label: "Overview", icon: LayoutGrid },
    { id: "courts", label: "Courts", icon: LayoutGrid },
    { id: "cameras", label: "Devices & cameras", icon: CameraIcon },
    { id: "settings", label: "Settings", icon: Settings2 },
    { id: "logs", label: "Recording logs", icon: List },
  ] as const;
  if (accessLost) return <main className="shell admin-main"><p role="status">Rechecking administrator access…</p></main>;

  return (
    <main className="shell admin-main admin-dashboard-main">
      {stale && <p className="recorder-alert" role="status">Dashboard status could not refresh. Showing the last available report.</p>}
      <h1 className="admin-sr-only">Venue management</h1>
      <nav className="admin-tabs" aria-label="Admin sections">
        {nav.map((item) => (
          <button
            key={item.id}
            aria-current={tab === item.id ? "page" : undefined}
            onClick={() => setTab(item.id)}
          >
            <item.icon size={16} />
            {item.label}
          </button>
        ))}
      </nav>

      <div
        className={`live-recording-indicator ${unconfirmed.length ? "is-unconfirmed" : recordingCourts.length ? "is-recording" : ""}`}
        role="status"
        aria-live="polite"
      >
        <span className="live-recording-dot" aria-hidden="true" />
        <div>
          <strong>
            {unconfirmed.length ? "Recording unconfirmed" : recordingCourts.length ? "Recording now" : "No live recordings"}
          </strong>
          <span>
            {unconfirmed.length ? `${unconfirmed.map(recordingCourtName).join(", ")}: the last capture report is stale or its recording limit has passed. Reconnect the original device to reconcile its saved video.` : recordingCourts.length
              ? recordingCourts.map((court) => court.name).join(", ")
              : "All courts are currently idle."}
          </span>
          {unconfirmed.length > 0 && <a href={`/admin?recording=${encodeURIComponent(unconfirmed[0].id)}`}>View recording log</a>}
          {unconfirmed.length > 0 && recordingCourts.length > 0 && <span>Confirmed recording: {recordingCourts.map(court => court.name).join(", ")}</span>}
        </div>
      </div>

      {tab === "overview" && (
        <section className="admin-card recorder-workspace" aria-labelledby="admin-overview-title">
          <header className="recorder-workspace-header">
            <div><h2 id="admin-overview-title">Overview</h2><p>Review court activity, recorder health, and replay delivery.</p></div>
          </header>
          {deviceStatusError && <p className="recorder-alert" role="status">{tablets
            ? "Recorder status could not refresh. Showing the last report."
            : "Recorder status is temporarily unavailable. Retrying automatically."}</p>}
          <dl className="recorder-overview-stats">
            {overviewStatuses.map(({ label, icon: Icon, value, tab: next }) => <div key={label}>
              <dt><Icon size={16} aria-hidden="true" />{label}</dt>
              <dd>{value ?? (deviceStatusError ? "—" : <AdminSkeleton label={`Loading ${label.toLowerCase()}`}><SkeletonBlock className="is-number" /></AdminSkeleton>)}</dd>
              <button type="button" className="recorder-text-action" onClick={() => { if (next === "logs") resetFilters(); setTab(next); }}>
                {next === "courts" ? "View courts" : next === "logs" ? "Open logs" : label === "Cameras ready" ? "Review cameras" : "View recorders"} <ChevronRight size={14} aria-hidden="true" />
              </button>
            </div>)}
          </dl>
          {!data.settings.venue_time_zone && <div className="recorder-alert admin-overview-notice">
            <span>Set your venue time zone to display recording dates in local time.</span>
            <button type="button" className="recorder-text-action" onClick={() => setTab("settings")}>Open settings <ChevronRight size={14} aria-hidden="true" /></button>
          </div>}
          <div className="admin-overview-grid">
            <section className="admin-work-panel">
              <header className="recorder-detail-section-heading"><div><h3>Court activity</h3><p>Current recording status by court.</p></div></header>
              {activeCourts.length ? <ul className="admin-compact-list">
                {activeCourts.map(court => {
                  const state = courtState(court);
                  return <li key={court.id}>
                    <button className="admin-compact-link" type="button" onClick={() => { setCourtId(court.id); setCourtSearch(""); setTab("courts"); }}>
                      <MapPin size={17} aria-hidden="true" /><strong>{court.name}</strong>
                      <span className={`recorder-state ${state.tone === "is-success" ? "" : state.tone}`}>{state.label === "Active" ? "Idle" : state.label}</span>
                      <ChevronRight size={15} aria-hidden="true" />
                    </button>
                  </li>;
                })}
              </ul> : <p className="recorder-empty-queue">Add a court to see activity here.</p>}
              {!activeCourts.length && <button type="button" className="secondary" onClick={() => setTab("courts")}>Set up courts</button>}
            </section>
            <StorageSmtpControls />
          </div>
        </section>
      )}

      {tab === "courts" && (
        <section className="admin-card recorder-workspace" aria-labelledby="admin-courts-title">
          <header className="recorder-workspace-header">
            <div><h2 id="admin-courts-title">Courts</h2><p>Manage court details and check which recorder serves each court.</p></div>
            <div className="recorder-workspace-actions">
              <button type="button" className="primary" onClick={() => { setCourtId(""); setNewCourtVersion(version => version + 1); }}>
                <Plus size={18} aria-hidden="true" /> Add court
              </button>
            </div>
          </header>
          <div className="recorder-workspace-grid">
            <section className="recorder-directory" aria-label="Court list">
              <div className="recorder-directory-heading"><h3>Your courts</h3><span>{data.courts.length}</span></div>
              {data.courts.length > 0 && <>
                <label className="recorder-search admin-court-search"><Search size={16} aria-hidden="true" />
                  <input type="search" aria-label="Find a court" placeholder="Find a court" value={courtSearch} onChange={event => setCourtSearch(event.target.value)} />
                </label>
                <ul className="recorder-directory-list">
                  {visibleCourts.map(court => {
                    const state = courtState(court);
                    return <li key={court.id}>
                      <button type="button" className={`recorder-directory-item ${currentCourt?.id === court.id ? "is-selected" : ""}`}
                        aria-pressed={currentCourt?.id === court.id} aria-controls="court-editor"
                        onClick={() => {
                          setCourtId(court.id);
                          if (window.matchMedia("(max-width: 760px)").matches) courtEditor.current?.scrollIntoView({ block: "start" });
                        }}>
                        <span className="recorder-directory-icon"><MapPin size={18} aria-hidden="true" /></span>
                        <span className="recorder-directory-copy"><strong>{court.name}</strong><span>{court.location || "No location set"}</span><span>{state.label}</span></span>
                        <ChevronRight size={16} aria-hidden="true" />
                      </button>
                    </li>;
                  })}
                </ul>
                {!visibleCourts.length && <p className="recorder-directory-empty">No courts match that search.</p>}
              </>}
              {!data.courts.length && <p className="recorder-directory-empty">Create your first court to assign a recorder.</p>}
            </section>
            <section className="recorder-device-panel" id="court-editor" ref={courtEditor} aria-label={currentCourt ? "Edit court" : "Add court"}>
              <header className="recorder-device-header">
                <div className="recorder-device-title">
                  <h3>{currentCourt?.name || "Add a court"}</h3>
                  {currentCourt && <span className={`recorder-state ${courtState(currentCourt).tone}`}>{courtState(currentCourt).label}</span>}
                </div>
              </header>
              <div className="recorder-detail-content">
                {currentCourt && <section className="recorder-facts">
                  <h4><CameraIcon size={17} aria-hidden="true" /> Assigned recorder</h4>
                  {assigned && presence ? <dl><dt>Recorder</dt><dd>{assigned.name}</dd><dt>Connection</dt><dd>{presence.label}</dd>
                    <dt>Camera</dt><dd>{assigned.camera_name || "Camera not reported"}</dd></dl>
                    : tablets ? <p>No recorder assigned to this court.</p>
                      : deviceStatusError ? <p>Recorder assignment is temporarily unavailable.</p>
                        : <AdminSkeleton label="Loading recorder assignment"><SkeletonBlock className="is-medium" /></AdminSkeleton>}
                  {deviceStatusError && tablets && <p className="admin-inline-note">Showing the last device report.</p>}
                  <button className="recorder-text-action" type="button" onClick={() => setTab("cameras")}>Manage recorders <ChevronRight size={14} aria-hidden="true" /></button>
                </section>}
                <CourtForm
                  key={`${currentCourt?.id || "new"}-${newCourtVersion}`}
                  court={currentCourt}
                  onSaved={id => { if (id) { setCourtId(id); setCourtSearch(""); } }}
                  onRemoved={() => setCourtId(null)}
                />
              </div>
            </section>
          </div>
        </section>
      )}

      {tab === "cameras" && <BrowserTabletsAdmin />}

      {tab === "settings" && (
        <section className="admin-card recorder-workspace" aria-labelledby="admin-settings-title">
          <header className="recorder-workspace-header">
            <div><h2 id="admin-settings-title">Settings</h2></div>
          </header>
          <div className="admin-settings-grid">
            <section className="admin-work-panel admin-recording-settings">
              <header className="recorder-detail-section-heading">
                <div><h3><Clock3 size={17} aria-hidden="true" /> Recording defaults</h3><p>Changes apply to new recordings at this venue.</p></div>
              </header>
              <SaveForm
                resource="settings"
                convert={(f) => ({
                  duration_minutes: Number(f.get("duration_minutes")),
                  retention_days: Number(f.get("retention_days")),
                  venue_time_zone: f.get("venue_time_zone"),
                })}
              >
                <div className="form-columns">
                  <label>
                    <span>Maximum recording duration (minutes)</span>
                    <input
                      type="number"
                      name="duration_minutes"
                      min={1}
                      max={120}
                      step={1}
                      aria-describedby="recording-duration-range"
                      defaultValue={data.settings.max_duration_seconds / 60}
                      required
                    />
                    <span className="form-note" id="recording-duration-range">1 to 120 minutes per recording.</span>
                  </label>
                  <label>
                    <span>Video retention after upload (days)</span>
                    <input
                      type="number"
                      name="retention_days"
                      min={MIN_RETENTION_DAYS}
                      max={MAX_RETENTION_DAYS}
                      step="any"
                      defaultValue={data.settings.retention_seconds / SECONDS_PER_DAY}
                      aria-describedby="video-retention-range"
                      required
                    />
                    <span className="form-note" id="video-retention-range">1 hour to 30 days from upload completion. Use 0.5 for 12 hours.</span>
                  </label>
                </div>
                <label>
                  Venue time zone
                  <input
                    name="venue_time_zone"
                    defaultValue={data.settings.venue_time_zone || ""}
                    list="time-zones"
                    placeholder="Search or type a time zone"
                    aria-describedby="venue-zone-help"
                    required
                  />
                  <datalist id="time-zones">
                    <option value="Asia/Manila" />
                    <option value="Asia/Taipei" />
                    <option value="Asia/Singapore" />
                    <option value="UTC" />
                  </datalist>
                  <span id="venue-zone-help" className="form-note">Used for recording times and replay deadlines. For example, Asia/Manila.</span>
                </label>
                <label className="check-label">
                  <input type="checkbox" required /> Apply these settings to future recordings.
                </label>
              </SaveForm>
            </section>
            <StorageSmtpControls />
          </div>
        </section>
      )}

      {tab === "logs" && (
        <section className="admin-card recorder-workspace" aria-labelledby="admin-logs-title">
          <header className="recorder-workspace-header">
            <div>
              <h2 id="admin-logs-title">Recording logs</h2>
              <p>Latest 100 recordings{initialRecordingId ? " plus the linked recording when available" : ""} · {zone}</p>
            </div>
          </header>
          <div className="admin-log-filters">
            <label>
              Find a recording
              <span className="recorder-search"><Search size={17} aria-hidden="true" />
                <input type="search" value={search} onChange={event => { setSearch(event.target.value); setLogPage(1); }} placeholder="Email, court, or session ID" />
              </span>
            </label>
            <label>
              Status
              <select value={status} onChange={event => { setStatus(event.target.value); setLogPage(1); }}>
                <option value="">All statuses</option>
                {Object.entries(recordingStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>
              Venue date
              <input type="date" value={date} onChange={event => { setDate(event.target.value); setLogPage(1); }} />
            </label>
            {(search || status || date) && <button className="secondary" type="button" onClick={resetFilters}>Clear filters</button>}
          </div>
          {filtered.length ? <ul className="admin-log-list" aria-label="Recording results">
            {pageSessions.map(session => {
              const recorderId = session.configuration_snapshot?.device_id;
              return <RecordingLogRow key={session.id}
                session={session} court={recordingCourtName(session)} recipients={recordingRecipients(session)}
                timestamp={timestamp} unconfirmed={session.status === "recording" && !confirmed(session)}
                focused={session.id === initialRecordingId} device={tablets?.find(device => device.id === recorderId)?.name || recorderId} />;
            })}
          </ul> : <div className="admin-log-empty">
            <List size={25} aria-hidden="true" />
            <h3>{search || status || date ? "No matching recordings" : "No recordings yet"}</h3>
            <p>{search || status || date ? "Try a different email, court, status, or date." : "Recordings will appear here after a match starts."}</p>
            {(search || status || date) && <button className="secondary" type="button" onClick={resetFilters}>Show all recordings</button>}
          </div>}
          {filtered.length > 0 && <nav className="log-pagination" aria-label="Recording log pages">
            <span role="status">{pageStart + 1}–{Math.min(pageStart + pageSize, filtered.length)} of {filtered.length} recordings</span>
            {pageCount > 1 && <div className="log-page-controls">
              <button type="button" className="sign-in" disabled={currentPage === 1} onClick={() => setLogPage(currentPage - 1)}>Previous</button>
              <span>Page {currentPage} of {pageCount}</span>
              <button type="button" className="sign-in" disabled={currentPage === pageCount} onClick={() => setLogPage(currentPage + 1)}>Next</button>
            </div>}
          </nav>}
        </section>
      )}
    </main>
  );
}
