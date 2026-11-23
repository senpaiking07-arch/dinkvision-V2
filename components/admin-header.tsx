import { ArrowLeft } from "lucide-react";
import type { Account } from "@/lib/auth";
import AccountControls from "./account-controls";

export default function AdminHeader({ account, back = false }: { account?: Account; back?: boolean }) {
  return (
    <header className="site-header shell admin-site-header">
      <a href="/admin" className="brand" aria-label="DinkVision Admin home">
        <img src="/dink-vision-logo.png" alt="DinkVision" />
        <span>Venue Management</span>
      </a>
      <div className="admin-header-actions">
        {back && <a href="/admin" className="sign-in"><ArrowLeft size={15} aria-hidden="true" /> Dashboard</a>}
        {account && <AccountControls account={account} showAdminLink={false} />}
      </div>
    </header>
  );
}
