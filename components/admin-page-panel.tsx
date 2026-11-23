import type { ReactNode } from "react";

export default function AdminPagePanel({ title, description, children }: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <main className="shell admin-main">
      <section className="admin-card recorder-workspace admin-page-panel">
        <header className="recorder-workspace-header">
          <div><h1>{title}</h1>{description && <p>{description}</p>}</div>
        </header>
        <div className="admin-work-panel admin-page-content">{children}</div>
      </section>
    </main>
  );
}
