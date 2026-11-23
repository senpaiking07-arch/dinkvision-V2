"use client";

import { useEffect, useState } from "react";
import { AdminSkeleton, SkeletonBlock } from "@/components/admin-skeleton";

export default function TabletQrEnrollment({ invite }: { invite: string }) {
  const [credential, setCredential] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [appPackage, setAppPackage] = useState("com.casabatik.recorder");

  useEffect(() => {
    const scanned = /^#code=([A-Za-z0-9_-]{12})$/.exec(location.hash);
    setCredential(scanned?.[1] || invite);
    if (scanned) history.replaceState(history.state, "", location.pathname + location.search);
    if (location.hostname === "127.0.0.1" || location.hostname === "localhost")
      setAppPackage("com.casabatik.recorder.dev");
    setLoaded(true);
  }, [invite]);

  if (!loaded) return <AdminSkeleton label="Checking enrollment invitation"><SkeletonBlock className="is-field" /></AdminSkeleton>;
  if (!credential) return <p role="status">Scan a valid enrollment QR from Devices &amp; cameras in Admin.</p>;

  return <>
    <p>Continue pairing in the DinkVision Android app.</p>
    <a className="primary" href={`intent://enroll/${credential}#Intent;scheme=dinkvision-recorder;package=${appPackage};end`}>
      Open DinkVision Android app
    </a>
  </>;
}
