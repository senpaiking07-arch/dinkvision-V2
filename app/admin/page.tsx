import { redirect } from "next/navigation";
import { getAccount } from "@/lib/auth";
import { serverSupabase } from "@/lib/supabase-server";
import AdminDashboard from "@/components/admin-dashboard";
import AccountControls from "@/components/account-controls";
import AppVersionFooter from "@/components/app-version-footer";
import type { AdminData } from "@/lib/admin-types";
import { uuid } from "@/lib/validation";
import { sessionCaptureReport } from "@/lib/recording-status";
import { recorderDatabase } from "@/lib/recorder-server";
import { captureColumns, withOptionalColumns } from "@/lib/optional-schema";

const baseSessionFields = "id,court_id,status,recipient_email,created_at,started_at,stopped_at,duration_seconds,stop_reason,failure_stage,configuration_snapshot,browser_recordings(last_seen_at,last_error,safe_error,upload_state,branding_state,local_available,duration_ms),capture_jobs(last_seen_at)";
const sessionFields = `${baseSessionFields},capture_interruption_code,capture_interrupted_at` as const;

// The dashboard is a live operational view. Do not let the route cache an
// earlier recording state between client refreshes.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminPage({ searchParams }: {
  searchParams: Promise<{ recording?: string | string[] }>;
}) {
  const { account } = await getAccount();
  if (!account) redirect("/admin/login");
  if (account.role !== "admin")
    return (
      <main className="auth-page">
        <section className="auth-card">
          <h1>Administrator access required.</h1>
          <p>Your player account does not have access to venue settings.</p>
          <a href="/" className="primary">
            Back to your courts
          </a>
        </section>
      </main>
    );
  const db = await serverSupabase();
  let focusedId = "";
  try { focusedId = uuid((await searchParams).recording); } catch { }
  const [
    courts,
    cameras,
    recorders,
    settings,
    sessions,
    events,
    devices,
    commands,
  ] = await Promise.all([
    db.from("courts").select("id,name,location,active").order("created_at"),
    db
      .from("cameras")
      .select(
        "id,name,recorder_id,court_id,source_type,device_reference,audio_source,is_primary,enabled,health,last_health_check_at",
      )
      .order("name"),
    db
      .from("recorders")
      .select(
        "id,name,last_seen_at,paired_at,agent_version,platform,ffmpeg_available",
      )
      .order("created_at"),
    db
      .from("venue_settings")
      .select("max_duration_seconds,retention_seconds,venue_time_zone")
      .eq("id", true)
      .single(),
    withOptionalColumns(
      () => db.from("recording_sessions").select(sessionFields).order("created_at", { ascending: false }).limit(100),
      () => db.from("recording_sessions").select(baseSessionFields).order("created_at", { ascending: false }).limit(100),
      captureColumns,
    ),
    db
      .from("audit_events")
      .select("id,action,created_at")
      .order("created_at", { ascending: false })
      .limit(20),
    db
      .from("recorder_devices")
      .select(
        "id,recorder_id,device_reference,name,source_type,health,diagnostic,last_test_at,audio_sources",
      )
      .order("name"),
    db
      .from("recorder_commands")
      .select("id,recorder_id,kind,status,created_at,result_code")
      .order("created_at", { ascending: false })
      .limit(30),
  ]);
  const sessionRows = sessions.data || [];
  const selected = focusedId && !sessionRows.some(session => session.id === focusedId)
    ? await withOptionalColumns(
        () => db.from("recording_sessions").select(sessionFields).eq("id", focusedId).maybeSingle(),
        () => db.from("recording_sessions").select(baseSessionFields).eq("id", focusedId).maybeSingle(),
        captureColumns,
      )
    : { data: null, error: null };
  const visibleSessions = selected.data ? [...sessionRows, selected.data] : sessionRows;
  const browserSessionIds = visibleSessions
    .filter(session => session.configuration_snapshot?.capture_mode === "browser")
    .map(session => session.id);
  // Browser capture reports intentionally have no authenticated SELECT policy.
  // Read only reports for sessions this admin has already been allowed to see
  // through RLS; never accept session IDs from the URL as authorization.
  const browserReports = browserSessionIds.length
    ? await recorderDatabase().from("browser_recordings")
        .select("session_id,last_seen_at,last_error,safe_error,upload_state,branding_state,local_available,duration_ms")
        .in("session_id", browserSessionIds)
    : { data: [], error: null };
  const reportBySession = new Map((browserReports.data || []).map(report => [report.session_id, report]));
  const dashboardSessions = visibleSessions.map(session => session.configuration_snapshot?.capture_mode === "browser"
    ? { ...session, browser_recordings: reportBySession.get(session.id) || null }
    : session);
  const failed = !!selected.error || !!browserReports.error || [
    courts,
    cameras,
    recorders,
    settings,
    sessions,
    events,
    devices,
    commands,
  ].some((result) => result.error);
  return (
    <>
      <header className="site-header shell">
        <a href="/" className="brand">
          <img src="/dink-vision-logo.png" alt="Dink Vision" />
          <span>
            Venue Management
          </span>
        </a>
        <AccountControls account={account} />
      </header>
      {failed ? (
        <main className="shell admin-main">
          <div className="empty-panel">
            <h2>Database setup needs attention.</h2>
            <p>
              The admin tables could not be loaded. Apply the project
              migrations, then reload this page.
            </p>
            <a className="primary" href="/admin">
              Reload dashboard
            </a>
          </div>
        </main>
      ) : (
        <AdminDashboard
          key={focusedId || "dashboard"}
          initialRecordingId={focusedId}
          data={
            {
              courts: courts.data,
              cameras: cameras.data,
              recorders: recorders.data,
              settings: settings.data,
              sessions: dashboardSessions,
              captureReports: dashboardSessions.map(sessionCaptureReport),
              events: events.data,
              devices: devices.data,
              commands: commands.data,
            } as AdminData
          }
        />
      )}
      <AppVersionFooter />
    </>
  );
}
