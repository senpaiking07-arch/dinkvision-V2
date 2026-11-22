import { AdminSkeleton, SkeletonBlock, SkeletonRows } from "@/components/admin-skeleton";

export default function LoadingAdmin() {
  return <>
    <header className="site-header shell">
      <a href="/" className="brand">
        <img src="/dink-vision-logo.png" alt="Dink Vision" />
        <span>Venue Management</span>
      </a>
    </header>
    <main className="shell admin-main">
      <div className="admin-title"><h1>Venue management</h1></div>
      <AdminSkeleton label="Loading the admin dashboard">
        <div className="admin-loading-nav">
          {Array.from({ length: 5 }, (_, index) => <SkeletonBlock key={index} className="is-field" />)}
        </div>
        <section className="admin-card recorder-workspace">
          <SkeletonBlock className="is-heading" />
          <div className="admin-loading-metrics">
            {Array.from({ length: 4 }, (_, index) => <SkeletonBlock key={index} className="is-card" />)}
          </div>
          <SkeletonRows />
        </section>
      </AdminSkeleton>
    </main>
  </>;
}
