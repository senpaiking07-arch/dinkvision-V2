import { redirect } from "next/navigation";
import { getAccount } from "@/lib/auth";
import AccountControls from "@/components/account-controls";
import TenantSettings from "@/components/tenant-settings";

export default async function TenantsPage() {
  const {account}=await getAccount();
  if (!account) redirect("/admin/login?next=/tenants");
  return <>
    <header className="site-header shell"><a className="brand" href="/"><img src="/dink-vision-logo.png" alt="DinkVision"/><span>Tenant management</span></a><AccountControls account={account}/></header>
    <main className="shell website-main">
      <header className="website-page-heading">
        <div><h1>{account.tenantName || "Venue management"}</h1><p>Manage locations, team access, and venue limits.</p></div>
      </header>
      <TenantSettings account={account} />
    </main>
  </>;
}
