import { loadAdminDashboard } from "@/lib/admin-dashboard-snapshot";
import { redirect } from "next/navigation";
import { getAccount } from "@/lib/auth";
import AdminDashboard from "@/components/admin-dashboard";
import AdminHeader from "@/components/admin-header";
import AdminPagePanel from "@/components/admin-page-panel";
import AppVersionFooter from "@/components/app-version-footer";
import { uuid } from "@/lib/validation";

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
  let focusedId = "";
  try { focusedId = uuid((await searchParams).recording); } catch { }
  const { failures, data } = await loadAdminDashboard(account.tenantId, focusedId);
  const needsDatabaseUpdate = failures.some(({ error }) =>
    ["42703", "42P01", "PGRST204", "PGRST205"].includes(error?.code || ""));
  return (
    <div className="admin-dashboard-page">
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
          key={JSON.stringify([account.id, account.tenantId, focusedId])}
          initialRecordingId={focusedId}
          data={data}
          realtimeScope={process.env.DINKVISION_ADMIN_REALTIME === "true" && account.tenantId
            ? { tenantId: account.tenantId, accountId: account.id } : undefined}
        />
      )}
      <AppVersionFooter />
    </div>
  );
}
