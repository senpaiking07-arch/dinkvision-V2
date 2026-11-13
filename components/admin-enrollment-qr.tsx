"use client";

import { useEffect, useState } from "react";
import { pairingCode } from "@/lib/tablet-enrollment";

const storageKey = "dinkvision.admin.enrollment-qr";

export type EnrollmentQr = { image: string; code: string; expiresAt: string };

export function enrollmentQrFromResponse(result: Record<string, unknown>): EnrollmentQr | null {
  const { qr, code, expiresAt } = result;
  return typeof qr === "string" && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(qr)
    && typeof code === "string" && pairingCode.test(code)
    && typeof expiresAt === "string" && Date.parse(expiresAt) > Date.now()
    ? { image: qr, code, expiresAt } : null;
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

export default function AdminEnrollmentQr() {
  const [invitation, setInvitation] = useState<EnrollmentQr | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let expiryTimer: number | undefined;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      const current = saved && enrollmentQrFromResponse({ ...saved, qr: saved.image });
      if (current) {
        setInvitation(current);
        expiryTimer = window.setTimeout(() => {
          setInvitation(null);
          sessionStorage.removeItem(storageKey);
        }, Date.parse(current.expiresAt) - Date.now());
      } else {
        sessionStorage.removeItem(storageKey);
      }
    } catch {
      setInvitation(null);
    } finally {
      setLoaded(true);
    }
    return () => window.clearTimeout(expiryTimer);
  }, []);

  return (
    <section className="auth-card enrollment-qr-card">
      <h1>Device enrollment</h1>
      {invitation ? (
        <>
          <p>Open enrollment in DinkVision. Scan the QR or enter the case-sensitive pairing code below. On a registered tablet, start with <strong>Re-enroll device</strong>.</p>
          <EnrollmentQrDetails invitation={invitation} />
          <p>Single use · Expires at <time dateTime={invitation.expiresAt}>{new Date(invitation.expiresAt).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}</time></p>
        </>
      ) : (
        <p role="status">{loaded ? "This invitation has expired or is unavailable. Open Devices & cameras in Admin to create a new QR." : "Loading enrollment invitation…"}</p>
      )}
      <a href="/admin" className="sign-in">Back to Admin</a>
    </section>
  );
}
