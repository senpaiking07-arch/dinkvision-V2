import "server-only";
import { recorderDatabase } from "./recorder-server";
import { deliverNextEmail } from "./email-server";
import { usesR2 } from "./r2-server";
import { runR2Jobs } from "./r2-jobs";

export async function runBrowserJobs(tenant?: string) {
  if (usesR2()) return runR2Jobs(tenant);
  const db = recorderDatabase();
  const stale = await db
    .from("browser_recordings")
    .select("session_id,recording_sessions!inner(status)")
    .in("recording_sessions.status", ["requested", "recording"])
    .lt("last_seen_at", new Date(Date.now() - 120000).toISOString())
    .limit(100);
  if (stale.error) throw stale.error;
  if (stale.data.length)
    await db
      .from("recording_sessions")
      .update({
        status: "failed",
        failure_stage: "browser_interrupted",
        stopped_at: new Date().toISOString(),
      })
      .in("id", stale.data.map((x) => x.session_id))
      .in("status", ["requested", "recording"]);
  await deliverNextEmail(undefined, undefined, tenant);
  const health = await db
    .from("venue_settings")
    .update({ browser_worker_at: new Date().toISOString() })
    .eq("id", true);
  if (health.error) throw health.error;
  return { ok: true };
}
