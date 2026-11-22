import { AdminSkeleton, SkeletonBlock } from "@/components/admin-skeleton";
import { WebsiteHeader } from "@/components/website-frame";

export default function LoadingReplay() {
  return <>
    <WebsiteHeader />
    <main className="shell website-main replay-page">
      <h1>Your match replay</h1>
      <AdminSkeleton label="Checking your replay link">
        <SkeletonBlock className="website-video-skeleton" />
        <SkeletonBlock className="is-card" />
      </AdminSkeleton>
    </main>
  </>;
}
