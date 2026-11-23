"use client";

import { useRef, useState } from "react";
import { AdminSkeleton, SkeletonBlock } from "@/components/admin-skeleton";

export default function ReplayVideo({ src }: { src: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed" | "decode-error">("loading");
  return <div className="replay-player">
    <video ref={video} controls playsInline preload="metadata" src={src} aria-label="Match replay"
      onLoadedMetadata={() => setState("ready")}
      onError={({ currentTarget }) => {
        const error = currentTarget.error;
        setState(error && error.code === error.MEDIA_ERR_DECODE ? "decode-error" : "failed");
      }} />
    {state === "loading" && <AdminSkeleton label="Loading replay video"><SkeletonBlock className="is-medium" /></AdminSkeleton>}
    {(state === "failed" || state === "decode-error") && <div className="website-notice" role="alert">
      <span>{state === "decode-error"
        ? "Your browser could not decode this video. Try another player, or turn off graphics acceleration in your browser settings and reopen the replay."
        : "Playback could not load. Retry playback or use the download link."}</span>
      <button className="sign-in" type="button" onClick={() => {
        setState("loading");
        video.current?.load();
      }}>Retry playback</button>
    </div>}
  </div>;
}
