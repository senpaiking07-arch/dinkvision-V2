import { redirect } from "next/navigation";
import { getAccount } from "@/lib/auth";
import { serverSupabase } from "@/lib/supabase-server";
import AdminDashboard from "@/components/admin-dashboard";
import AdminHeader from "@/components/admin-header";
import AdminPagePanel from "@/components/admin-page-panel";
import AppVersionFooter from "@/components/app-version-footer";
import type { AdminData } from "@/lib/admin-types";
import { uuid } from "@/lib/validation";
import { sessionCaptureReport } from "@/lib/recording-status";
import { recorderDatabase } from "@/lib/recorder-server";
import { captureColumns, withOptionalColumns } from "@/lib/optional-schema";

const baseSessionFields = "id,court_id,status,recipient_email,created_at,started_at,stopped_at,duration_seconds,stop_reason,failure_stage,configuration_snapshot,capture_jobs(last_seen_at)";
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
      <>
        <AdminHeader account={account} />
        <AdminPagePanel title="Administrator access required" description="Sign in with a venue administrator account to manage this venue.">
          <p className="admin-inline-note">Use Sign out above to switch accounts.</p>
        </AdminPagePanel>
      </>
    );
  const db = await serverSupabase(account.tenantId);
  let focusedId = "";
  try { focusedId = uuid((await searchParams).recording); } catch { }
  const [
    courts,
    settings,
    sessions,
  ] = await Promise.all([
    db.from("courts").select("id,name,location,active").order("created_at"),
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
    ? await recorderDatabase(account.tenantId).from("browser_recordings")
        .select("session_id,last_seen_at,last_error,safe_error,upload_state,branding_state,local_available,duration_ms")
        .in("session_id", browserSessionIds)
    : { data: [], error: null };
  const reportBySession = new Map((browserReports.data || []).map(report => [report.session_id, report]));
  const dashboardSessions = visibleSessions.map(session => session.configuration_snapshot?.capture_mode === "browser"
    ? { ...session, browser_recordings: reportBySession.get(session.id) || null }
    : session);
  const failures = [
    { label: "Courts", error: courts.error },
    { label: "Recording settings", error: settings.error },
    { label: "Recording logs", error: sessions.error },
    { label: "Linked recording", error: selected.error },
    { label: "Recorder status", error: browserReports.error },
  ].filter(({ error }) => error);
  const needsDatabaseUpdate = failures.some(({ error }) =>
    ["42703", "42P01", "PGRST204", "PGRST205"].includes(error?.code || ""));
  return (
    <>
      <AdminHeader account={account} />
      {failures.length > 0 ? (
        <main className="shell admin-main">
          <section className="admin-card recorder-workspace admin-page-panel">
            <header className="recorder-workspace-header"><div>
              <h1>{needsDatabaseUpdate ? "Database setup needs attention" : "Admin data could not load"}</h1>
              <p>{needsDatabaseUpdate
                ? "Check that the installed Supabase migrations match this DinkVision release."
                : "Reload the dashboard. If this continues, verify the Supabase connection and administrator access."}</p>
            </div></header>
            <a className="primary" href="/admin">
              Reload dashboard
            </a>
            <details className="recorder-disclosure">
              <summary>Affected sections</summary>
              <p className="admin-inline-note">{failures.map(({ label }) => label).join(", ")}</p>
            </details>
          </section>
        </main>
      ) : (
        <AdminDashboard
          key={focusedId || "dashboard"}
          initialRecordingId={focusedId}
          data={
            {
              courts: courts.data,
              settings: settings.data,
              sessions: dashboardSessions,
              captureReports: dashboardSessions.map(sessionCaptureReport),
            } as Pick<AdminData, "courts" | "settings" | "sessions" | "captureReports">
          }
        />
      )}
      <AppVersionFooter />
    </>
  );
}
