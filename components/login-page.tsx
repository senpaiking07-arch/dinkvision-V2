import LoginForm from "./login-form";
import { isConfigured } from "@/lib/supabase-server";
import { getAccount } from "@/lib/auth";
import { redirect } from "next/navigation";
import AdminHeader from "./admin-header";
import AdminPagePanel from "./admin-page-panel";

export default async function LoginPage({
  admin = false,
  next,
}: {
  admin?: boolean;
  next?: string;
}) {
  const { account, problem } = await getAccount();
  if (account && (!admin || account.role === "admin"))
    redirect(account.role === "admin" ? next || "/admin" : "/");
  return <>
    <AdminHeader />
    <AdminPagePanel title={admin ? "Venue sign-in" : "Player sign-in"}
      description={admin ? "Use your venue account to manage courts, recorders, and replays." : "Sign in to access your venue’s courts."}>
        {problem && (
          <p className="form-error" role="alert">
            {problem}
          </p>
        )}
        <LoginForm admin={admin} next={next} configured={isConfigured()} />
        {!admin && <a className="auth-switch" href="/admin/login">Venue administrator sign-in</a>}
    </AdminPagePanel>
  </>;
}
