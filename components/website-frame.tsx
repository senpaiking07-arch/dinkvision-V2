import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

export function WebsiteHeader({ back }: { back?: { href: string; label: string } }) {
  return <header className="shell website-header">
    <a className="brand" href="/" aria-label="DinkVision recording screen">
      <img src="/dink-vision-logo.png" alt="DinkVision" />
    </a>
    {back && <a className="sign-in" href={back.href}><ArrowLeft size={16} aria-hidden="true" />{back.label}</a>}
  </header>;
}

export function WebsiteMessage({ title, children }: { title: string; children: ReactNode }) {
  return <>
    <WebsiteHeader />
    <main className="shell website-main">
      <section className="website-panel website-message">
        <h1>{title}</h1>
        {children}
      </section>
    </main>
  </>;
}
