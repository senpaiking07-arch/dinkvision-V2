"use client";

import { useRef, useState } from "react";
import { AdminSkeleton, SkeletonBlock } from "@/components/admin-skeleton";

export default function ReplayVideo({ src }: { src: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  return <div className="replay-player">
    <video ref={video} controls playsInline preload="metadata" src={src} aria-label="Match replay"
      onLoadedMetadata={() => setState("ready")} onError={() => setState("failed")} />
    {state === "loading" && <AdminSkeleton label="Loading replay video"><SkeletonBlock className="is-medium" /></AdminSkeleton>}
    {state === "failed" && <div className="website-notice" role="alert">
      <span>Playback could not load. Retry playback or use the download link.</span>
      <button className="sign-in" type="button" onClick={() => {
        setState("loading");
        video.current?.load();
      }}>Retry playback</button>
    </div>}
  </div>;
}
