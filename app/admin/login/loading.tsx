import AdminHeader from "@/components/admin-header";
import AdminPagePanel from "@/components/admin-page-panel";
import { AdminSkeleton, SkeletonBlock } from "@/components/admin-skeleton";

export default function LoadingAdminSignIn() {
  return <>
    <AdminHeader />
    <AdminPagePanel title="Venue sign-in">
      <AdminSkeleton label="Loading sign-in">
        <SkeletonBlock className="is-field" />
        <SkeletonBlock className="is-field" />
        <SkeletonBlock className="is-field is-medium" />
      </AdminSkeleton>
    </AdminPagePanel>
  </>;
}
