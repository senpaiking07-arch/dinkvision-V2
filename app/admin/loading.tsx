import { AdminSkeleton, SkeletonBlock, SkeletonRows } from "@/components/admin-skeleton";
import AdminHeader from "@/components/admin-header";

export default function LoadingAdmin() {
  return <>
    <AdminHeader />
    <main className="shell admin-main">
      <h1 className="admin-sr-only">Venue management</h1>
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
