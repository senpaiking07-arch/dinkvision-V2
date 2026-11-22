"use client";
import { useEffect, useState } from "react";
type Status = {
  provider?: string;
  storage?: { ready: boolean; code: string; checkedAt: string };
  smtp?: { ready: boolean; configured: boolean; from?: string; checkedAt: string; detail?: string };
};
export default function StorageSmtpControls() {
  const [data, setData] = useState<Status>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function refresh(force = false) {
    setBusy(true);
    try {
      const r = await fetch(force ? "/api/integrations/storage/health" : "/api/integrations/storage/status", force ? { method: "POST" } : { cache: "no-store" });
      const value = await r.json();
      if (!r.ok) throw new Error(value.error || "Status unavailable");
      setData(value.storage ? { provider: "r2", storage: value.storage || value, smtp: value.smtp } : value);
      if (force && value.message) setMessage(value.message);
    } catch {
      setMessage("Storage/email status is temporarily unavailable.");
    } finally { setBusy(false); }
  }
  useEffect(() => { void refresh(false); const t = setInterval(() => void refresh(false), 15000); return () => clearInterval(t); }, []);
  const storageReady = !!data?.storage?.ready;
  const smtpReady = !!data?.smtp?.ready;
  const smtpConfigured = !!data?.smtp?.configured;
  return <section className="admin-card storage-integration-card" aria-label="Storage and email readiness">
    <div className="eyebrow">STORAGE & EMAIL</div>
    <h2>{busy ? "Checking storage/email..." : storageReady && smtpReady ? "R2 storage and SMTP email connected" : "Storage or email needs attention"}</h2>
    <p role="status">Private video storage: {storageReady ? "Connected (R2)" : "Needs attention"}. Email delivery: {smtpReady ? `Connected${data?.smtp?.from ? ` as ${data.smtp.from}` : ""}` : smtpConfigured ? "Configured but unavailable" : "Not configured"}.</p>
    {data?.smtp?.detail && !smtpReady && <p className="form-note">SMTP: {data.smtp.detail}</p>}
    <p className="form-note">Configure SMTP with server env vars: SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM. No Google OAuth required.</p>
    <button className="sign-in" disabled={busy} onClick={() => void refresh(true)}>{busy ? "Checking..." : "Check again"}</button>
    {message && <p role="status" className="form-note">{message}</p>}
  </section>;
}
