"use client";

import { useEffect, useRef, useState } from "react";
import { CloudUpload, Mail, RefreshCw } from "lucide-react";
import { AdminSkeleton, SkeletonBlock } from "@/components/admin-skeleton";

type Status = {
  provider?: string;
  storage?: { ready: boolean; code: string; checkedAt: string };
  smtp?: { ready: boolean; configured: boolean; from?: string; checkedAt: string; detail?: string };
};

export default function StorageSmtpControls() {
  const [data, setData] = useState<Status>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const active = useRef<AbortController | null>(null);

  async function refresh(force = false) {
    if (active.current && !force) return;
    active.current?.abort();
    const request = new AbortController();
    active.current = request;
    if (force) { setBusy(true); setMessage(""); }
    try {
      const response = await fetch(force ? "/api/integrations/storage/health" : "/api/integrations/storage/status", {
        method: force ? "POST" : "GET",
        cache: "no-store",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "Status unavailable");
      if (request.signal.aborted) return;
      setData(value);
      setFailed(false);
      if (force) setMessage("Connection check finished.");
    } catch {
      if (!request.signal.aborted) setFailed(true);
    } finally {
      if (active.current === request) active.current = null;
      if (force && !request.signal.aborted) setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => { clearInterval(timer); active.current?.abort(); active.current = null; };
  }, []);

  const storageReady = !!data?.storage?.ready;
  const smtpReady = !!data?.smtp?.ready;
  const smtpConfigured = !!data?.smtp?.configured;

  return <section className="admin-work-panel admin-services" aria-label="Storage and email readiness">
    <header className="recorder-detail-section-heading">
      <div><h3>Storage &amp; email</h3>
        {data && <p>{storageReady && smtpReady ? "R2 storage and SMTP email connected" : "One or more services need attention."}</p>}
      </div>
      <button className="secondary" type="button" disabled={busy || (!data && !failed)} onClick={() => void refresh(true)}>
        <RefreshCw size={15} aria-hidden="true" />{busy ? "Checking…" : "Check again"}
      </button>
    </header>
    {!data && !failed && <AdminSkeleton label="Checking storage and email">
      <div className="admin-service-grid"><SkeletonBlock className="is-card" /><SkeletonBlock className="is-card" /></div>
    </AdminSkeleton>}
    {data && <div className="admin-service-grid">
      <div className="recorder-facts">
        <h4><CloudUpload size={17} aria-hidden="true" /> Cloudflare R2</h4>
        <span className={`recorder-state ${storageReady ? "is-success" : "is-warning"}`}>{storageReady ? "Connected" : "Needs attention"}</span>
        <p>Private video storage</p>
      </div>
      <div className="recorder-facts">
        <h4><Mail size={17} aria-hidden="true" /> Replay email</h4>
        <span className={`recorder-state ${smtpReady ? "is-success" : "is-warning"}`}>{smtpReady ? "Connected" : smtpConfigured ? "Configured but unavailable" : "Not configured"}</span>
        {smtpReady && data.smtp?.from && <p>{data.smtp.from}</p>}
        {!smtpReady && data.smtp?.detail && <p>{data.smtp.detail}</p>}
      </div>
    </div>}
    {data?.smtp && !smtpReady && !smtpConfigured && <p className="admin-inline-note">Configure SMTP using the server variables <code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_SECURE</code>, <code>SMTP_USER</code>, <code>SMTP_PASS</code>, and <code>SMTP_FROM</code>.</p>}
    {failed && <p className="recorder-alert" role="status">{data ? "Could not refresh. Showing the last connection check." : "Connection status is temporarily unavailable."}</p>}
    {message && !failed && <p role="status" className="admin-inline-note">{message}</p>}
  </section>;
}
