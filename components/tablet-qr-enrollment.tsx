"use client";

import { useEffect, useRef, useState } from "react";
import { enrollmentPin } from "@/lib/tablet-enrollment";
import { AdminSkeleton, SkeletonBlock } from "@/components/admin-skeleton";

export default function TabletQrEnrollment({ invite }: { invite: string }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [replace, setReplace] = useState(false);
  const [code, setCode] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [appPackage, setAppPackage] = useState("com.casabatik.recorder");
  const submitting = useRef(false);
  const attempt = useRef("");
  useEffect(() => {
    const scanned = /^#code=([A-Za-z0-9_-]{12})$/.exec(location.hash);
    if (scanned) {
      setCode(scanned[1]);
      history.replaceState(history.state, "", location.pathname + location.search);
    }
    if (location.hostname === "127.0.0.1" || location.hostname === "localhost")
      setAppPackage("com.casabatik.recorder.dev");
    setLoaded(true);
  }, []);
  const credential = code || invite;
  if (!loaded) return <AdminSkeleton label="Checking enrollment invitation"><SkeletonBlock className="is-field" /></AdminSkeleton>;
  if (!credential) return <p role="status">Scan a valid enrollment QR from Devices &amp; cameras in Admin.</p>;
  const appLink = `intent://enroll/${credential}#Intent;scheme=dinkvision-recorder;package=${appPackage};end`;

  return (
    <>
      <p>{code ? "Open DinkVision to confirm pairing on this tablet." : "For the Android recorder, open the app and enter the six-digit PIN shown in Admin."}</p>
      <p><a className="sign-in primary" href={appLink}>Open DinkVision Android app</a></p>
      <details className="website-disclosure">
        <summary>Enroll the browser instead</summary>
        <form className="stack-form" onSubmit={async (event) => {
          event.preventDefault();
          if ((!code && !enrollmentPin.test(pin)) || submitting.current) return;
          submitting.current = true;
          setBusy(true);
          setError("");
          try {
            if (!attempt.current) {
              const bytes = crypto.getRandomValues(new Uint8Array(32));
              attempt.current = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
            }
            const response = await fetch("/api/tablet/enroll", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...(code ? {code} : {invite, pin}), replace, attempt: attempt.current }),
            });
            const result = await response.json();
            if (response.ok && result.ok === true) {
              location.replace("/tablet/setup");
              return;
            }
            setReplace(result.replacementRequired === true);
            setError(result.error || "Enrollment could not be verified. Try again.");
          } catch {
            setError("Connection interrupted. Try again to check this pairing attempt.");
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}>
          {!code && <label className="field">
            Verification PIN
            <input name="pin" type="password" inputMode="numeric" autoComplete="off"
              value={pin} required maxLength={6} pattern="[0-9]{6}"
              onChange={event => setPin(event.target.value.replace(/[^0-9]/g, ""))} />
          </label>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary" disabled={busy || (!code && !enrollmentPin.test(pin))}>
            {busy ? "Verifying…" : replace ? "Confirm replacement" : "Confirm browser enrollment"}
          </button>
        </form>
      </details>
    </>
  );
}
