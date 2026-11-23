"use client";

import AdminHeader from "@/components/admin-header";
import AdminPagePanel from "@/components/admin-page-panel";

export default function AdminError({ reset }: { reset: () => void }) {
  return <>
    <AdminHeader />
    <AdminPagePanel title="Admin could not load" description="Reload this section or return to the dashboard.">
      <div className="recorder-workspace-actions">
        <button type="button" className="primary" onClick={reset}>Try again</button>
        <a href="/admin" className="sign-in">Dashboard</a>
      </div>
    </AdminPagePanel>
  </>;
}
