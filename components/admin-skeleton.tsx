import type { ReactNode } from "react";

export function SkeletonBlock({ className = "" }: { className?: string }) {
  return <span className={`admin-skeleton-block ${className}`} aria-hidden="true" />;
}

export function AdminSkeleton({ label, children }: { label: string; children: ReactNode }) {
  return <div className="admin-skeleton" role="status">
    <span className="admin-sr-only">{label}</span>
    <div className="admin-skeleton-parts" aria-hidden="true">{children}</div>
  </div>;
}

export function SkeletonRows({ count = 3 }: { count?: number }) {
  return <div className="admin-skeleton-rows">
    {Array.from({ length: count }, (_, index) => <div className="admin-skeleton-row" key={index}>
      <SkeletonBlock className="is-square" />
      <div><SkeletonBlock className="is-medium" /><SkeletonBlock className="is-short" /></div>
    </div>)}
  </div>;
}
