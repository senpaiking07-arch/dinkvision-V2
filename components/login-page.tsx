import LoginForm from "./login-form";
import { isConfigured } from "@/lib/supabase-server";
import { getAccount } from "@/lib/auth";
import { redirect } from "next/navigation";
import { WebsiteHeader } from "@/components/website-frame";

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
    <WebsiteHeader back={{ href: "/", label: "Recording screen" }} />
    <main className="shell website-main">
      <div className="website-sign-in">
        <section className="website-panel">
        <h1>{admin ? "Venue sign-in" : "Player sign-in"}</h1>
        <p>
          {admin
            ? "Manage your courts, cameras, and club settings."
            : "Sign in to access your venue’s courts."}
        </p>
        {problem && (
          <p className="form-error" role="alert">
            {problem}
          </p>
        )}
        <LoginForm admin={admin} next={next} configured={isConfigured()} />
        {!admin && <a className="auth-switch" href="/admin/login">Venue administrator sign-in</a>}
        </section>
        <div className="site-court-art website-sign-in-art" aria-hidden="true" />
      </div>
    </main>
  </>;
}
