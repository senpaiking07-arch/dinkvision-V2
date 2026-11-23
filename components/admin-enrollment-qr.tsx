"use client";

import { useEffect, useState } from "react";
import { pairingCode } from "@/lib/tablet-enrollment";

const storageKey = "dinkvision.admin.enrollment-qr";

export type EnrollmentQr = { id?: string; image: string; code: string; expiresAt: string };
type PairingStatus = "pending" | "paired" | "unavailable";

export function enrollmentQrFromResponse(result: Record<string, unknown>): EnrollmentQr | null {
  const { id, qr, code, expiresAt } = result;
  return typeof qr === "string" && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(qr)
    && typeof code === "string" && pairingCode.test(code)
    && typeof expiresAt === "string" && Date.parse(expiresAt) > Date.now()
    ? { id: typeof id === "string" ? id : undefined, image: qr, code, expiresAt } : null;
}

export function reserveEnrollmentTab() {
  const tab = window.open("", "_blank");
  if (!tab) return null;
  try {
    tab.opener = null;
    tab.document.title = "DinkVision enrollment";
    tab.document.body.textContent = "Creating your enrollment invitation…";
    return tab;
  } catch {
    tab.close();
    return null;
  }
}

export function showEnrollmentTab(tab: Window | null, invitation: EnrollmentQr) {
  if (!tab || tab.closed) return false;
  try {
    // Keep the Admin tab URL free of pairing credentials.
    tab.sessionStorage.setItem(storageKey, JSON.stringify(invitation));
    tab.location.replace("/admin/enrollment");
    return true;
  } catch {
    tab.close();
    return false;
  }
}

export function EnrollmentQrDetails({ invitation }: { invitation: EnrollmentQr }) {
  return (
    <div className="enrollment-qr-details">
      <img src={invitation.image} width={280} height={280} alt="DinkVision device enrollment QR code" />
      <p>Pairing code <code className="enrollment-code">{invitation.code}</code></p>
    </div>
  );
}

export function EnrollmentInvitation({
  invitation,
  closeTabOnSuccess = false,
  instructions,
  openTab,
}: {
  invitation: EnrollmentQr;
  closeTabOnSuccess?: boolean;
  instructions?: string;
  openTab?: () => void;
}) {
  const [status, setStatus] = useState<PairingStatus>("pending");
  const [statusError, setStatusError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let pollTimer: number | undefined;
    let closeTimer: number | undefined;

    const finish = (result: "paired" | "unavailable") => {
      window.clearTimeout(expiryTimer);
      controller.abort();
      setStatus(result);
      if (!closeTabOnSuccess) return;
      try { sessionStorage.removeItem(storageKey); } catch { /* Storage may be unavailable. */ }
      if (result === "paired") closeTimer = window.setTimeout(() => window.close(), 2500);
    };

    const expiryTimer = window.setTimeout(
      () => finish("unavailable"),
      Math.max(0, Date.parse(invitation.expiresAt) - Date.now()),
    );

    const check = async () => {
      try {
        const response = await fetch("/api/admin/tablets/enrollment-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: invitation.id, code: invitation.code }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (response.status === 403) {
          setStatusError("Return to Admin and sign in again to check pairing status.");
          controller.abort();
          return;
        }
        if (!response.ok) {
          setStatusError("Pairing status is temporarily unavailable. Checking again…");
          return;
        }
        const { status: result } = await response.json();
        if (controller.signal.aborted) return;
        setStatusError("");
        if (result === "paired" || result === "unavailable") finish(result);
      } catch {
        if (!controller.signal.aborted)
          setStatusError("Could not check pairing status. Checking again…");
      } finally {
        if (!controller.signal.aborted) pollTimer = window.setTimeout(() => void check(), 3000);
      }
    };

    if (invitation.id) void check();
    return () => {
      controller.abort();
      window.clearTimeout(pollTimer);
      window.clearTimeout(closeTimer);
      window.clearTimeout(expiryTimer);
    };
  }, [invitation, closeTabOnSuccess]);

  if (status === "paired") return (
    <div role="status" className="recorder-alert is-success admin-enrollment-status">
      <strong>Device paired</strong>
      <p>Continue with the three-second camera check on the Android device.</p>
      {closeTabOnSuccess && <p>This tab will close shortly. You can also return to Admin below.</p>}
    </div>
  );
  if (status === "unavailable") return (
    <p role="status" className="recorder-alert">This invitation is no longer available. Open Devices &amp; cameras in Admin to create a new one.</p>
  );
  return (
    <>
      {instructions && <p>{instructions}</p>}
      <EnrollmentQrDetails invitation={invitation} />
      <p>Single use · Expires at <time dateTime={invitation.expiresAt}>{new Date(invitation.expiresAt).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}</time></p>
      <p role="status" className="recorder-alert">{statusError || (invitation.id ? "Waiting for the device to pair…" : "Check Devices & cameras for the result of this invitation.")}</p>
      {openTab && <button type="button" className="sign-in" onClick={openTab}>Open QR tab</button>}
    </>
  );
}

export default function AdminEnrollmentQr() {
  const [invitation, setInvitation] = useState<EnrollmentQr | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      const current = saved && enrollmentQrFromResponse({ ...saved, qr: saved.image });
      if (current) setInvitation(current);
      else sessionStorage.removeItem(storageKey);
    } catch {
      setInvitation(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  return (
    <section className="admin-card recorder-workspace admin-page-panel enrollment-qr-card">
      <header className="recorder-workspace-header">
        <div><h1>Device enrollment</h1><p>Pair a recorder in the DinkVision Android app.</p></div>
      </header>
      <div className="admin-work-panel admin-page-content">
      {invitation ? (
        <EnrollmentInvitation invitation={invitation} closeTabOnSuccess
          instructions="Open enrollment in DinkVision. Scan the QR or enter the code below. On a registered tablet, start with Re-enroll device." />
      ) : loaded ? (
        <p role="status" className="recorder-alert">This invitation has expired or is unavailable. Open Devices &amp; cameras in Admin to create a new QR.</p>
      ) : (
        <div role="status"><span className="admin-sr-only">Loading enrollment invitation</span>
          <span className="admin-skeleton-block enrollment-qr-skeleton" aria-hidden="true" />
        </div>
      )}
      </div>
    </section>
  );
}
