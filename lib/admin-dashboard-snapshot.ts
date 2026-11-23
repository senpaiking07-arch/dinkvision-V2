import "server-only";
import { serverSupabase } from "@/lib/supabase-server";
import type { AdminData } from "@/lib/admin-types";
import { sessionCaptureReport } from "@/lib/recording-status";
import { recorderDatabase } from "@/lib/recorder-server";
import { captureColumns, withOptionalColumns } from "@/lib/optional-schema";

const baseSessionFields = "id,court_id,status,recipient_email,created_at,started_at,stopped_at,duration_seconds,stop_reason,failure_stage,configuration_snapshot,capture_jobs(last_seen_at)";
const sessionFields = `${baseSessionFields},capture_interruption_code,capture_interrupted_at` as const;

export async function loadAdminDashboard(tenantId: string | undefined, focusedId: string) {
  const db = await serverSupabase(tenantId);
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
    ? await recorderDatabase(tenantId).from("browser_recordings")
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
  return { failures, data: { courts: courts.data, settings: settings.data, sessions: dashboardSessions,
    captureReports: dashboardSessions.map(sessionCaptureReport),
  } as Pick<AdminData, "courts" | "settings" | "sessions" | "captureReports"> };
}
