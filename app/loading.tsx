import { AdminSkeleton, SkeletonBlock, SkeletonRows } from "@/components/admin-skeleton";
import { WebsiteHeader } from "@/components/website-frame";

export default function Loading() {
  return (
    <>
      <WebsiteHeader />
      <main className="shell website-main">
        <AdminSkeleton label="Loading DinkVision">
          <SkeletonBlock className="website-hero-skeleton" />
          <SkeletonRows count={2} />
        </AdminSkeleton>
      </main>
    </>
  );
}
