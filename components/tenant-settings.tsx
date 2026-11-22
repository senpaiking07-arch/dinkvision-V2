"use client";

import { Building2, CloudUpload, MapPin, SlidersHorizontal, Users } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { Account } from "@/lib/auth";
import { AdminSkeleton, SkeletonRows } from "@/components/admin-skeleton";

type Details = {
  locations?: { id: string; name: string; active: boolean }[];
  members?: { user_id: string; role: string; active: boolean; profiles: { display_name: string } | null }[];
  storageBytes?: number;
  limits?: { max_devices: number | null; max_courts: number | null; storage_limit_bytes: number | null };
};
type Action = "switch" | "create" | "location" | "membership" | "limits";

async function loadTenantDetails(signal?: AbortSignal): Promise<Details> {
  const response = await fetch("/api/tenants", { cache: "no-store", signal });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Venue details are unavailable.");
  return data;
}

export default function TenantSettings({ account }: { account: Account }) {
  const [details, setDetails] = useState<Details | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<Action | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    void loadTenantDetails(signal)
      .then(data => { if (!controller.signal.aborted) { setDetails(data); setLoadFailed(false); } })
      .catch(() => { if (!controller.signal.aborted) setLoadFailed(true); });
    return () => controller.abort();
  }, [loadVersion]);

  async function submit(event: FormEvent<HTMLFormElement>, action: Action) {
    event.preventDefault();
    if (busy) return;
    setBusy(action);
    setMessage("");
    setError("");
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const limits = action === "limits" ? Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === "" ? null : Number(value)])) : {};
    try {
      const response = await fetch("/api/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, ...limits, action, ...(action === "membership" ? { active: values.active === "true" } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || "Unable to save.");
      if (action === "switch" || action === "create") {
        window.location.assign("/tenants");
        return;
      }
      if (action !== "limits") form.reset();
      setLoadVersion(version => version + 1);
      setMessage("Changes saved.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save. Please retry.");
    } finally {
      setBusy(null);
    }
  }

  return <>
    {message && <p className="website-notice" role="status">{message}</p>}
    {error && <p className="website-notice is-error" role="alert">{error}</p>}
    {loadFailed && <div className="website-notice" role="status">
      <span>{details ? "Showing the last available venue details." : "Venue details could not load."}</span>
      <button className="sign-in" type="button" onClick={() => { setLoadFailed(false); setLoadVersion(version => version + 1); }}>Try again</button>
    </div>}
    <div className="website-card-grid">
      {!!account.tenants?.length && <section className="website-panel">
        <h2><Building2 size={20} aria-hidden="true" /> Current venue</h2>
        <form className="stack-form" onSubmit={event => void submit(event, "switch")}>
          <fieldset disabled={busy !== null}>
            <label>Venue<select name="tenant_id" defaultValue={account.tenantId || ""}>
              {account.tenants.map(tenant => <option key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.role}</option>)}
            </select></label>
          </fieldset>
          <div className="website-actions"><button className="primary" disabled={busy !== null}>{busy === "switch" ? "Switching…" : "Switch venue"}</button>
            <a className="sign-in" href="/admin">Open dashboard</a></div>
        </form>
      </section>}
      <section className="website-panel">
        <h2><Building2 size={20} aria-hidden="true" /> Register a venue</h2>
        <form className="stack-form" onSubmit={event => void submit(event, "create")}>
          <fieldset disabled={busy !== null}>
            <label>Business name<input name="name" required maxLength={100} /></label>
            <label>Venue address slug<input name="slug" required minLength={2} maxLength={63} pattern="[a-z0-9][a-z0-9\-]+" placeholder="your-club" /></label>
          </fieldset>
          <button className="primary" disabled={busy !== null}>{busy === "create" ? "Creating…" : "Create venue"}</button>
        </form>
      </section>

      {account.role === "admin" && (
        !details ? (!loadFailed && <section className="website-panel" aria-label="Venue details">
          <AdminSkeleton label="Loading locations, team, and storage"><SkeletonRows /></AdminSkeleton>
        </section>) : <>
          <section className="website-panel">
            <h2><MapPin size={20} aria-hidden="true" /> Locations</h2>
            {details.locations?.length ? <ul className="website-data-list">
              {details.locations.map(location => <li key={location.id}>{location.name}
                <span className={`recorder-state ${location.active ? "is-success" : ""}`}>{location.active ? "Active" : "Inactive"}</span>
              </li>)}
            </ul> : <p>No locations added yet.</p>}
            <form className="stack-form" onSubmit={event => void submit(event, "location")}>
              <fieldset disabled={busy !== null}><label>Location name<input name="name" required maxLength={150} /></label></fieldset>
              <button className="primary" disabled={busy !== null}>{busy === "location" ? "Adding…" : "Add location"}</button>
            </form>
          </section>
          <section className="website-panel">
            <h2><Users size={20} aria-hidden="true" /> Team access</h2>
            {details.members?.length ? <ul className="website-data-list">
              {details.members.map(member => <li key={member.user_id}><span>{member.profiles?.display_name || member.user_id}</span>
                <span className={`recorder-state ${member.active ? "is-success" : ""}`}>{member.active ? member.role : "Access removed"}</span></li>)}
            </ul> : <p>No team memberships found.</p>}
            <form className="stack-form" onSubmit={event => void submit(event, "membership")}>
              <fieldset disabled={busy !== null}>
                <label>Existing account email<input name="email" type="email" required /></label>
                <div className="form-columns">
                  <label>Role<select name="role"><option value="player">Player</option><option value="admin">Venue administrator</option></select></label>
                  <label>Access<select name="active"><option value="true">Enabled</option><option value="false">Removed</option></select></label>
                </div>
              </fieldset>
              <button className="primary" disabled={busy !== null}>{busy === "membership" ? "Saving…" : "Save membership"}</button>
            </form>
          </section>
          <section className="website-panel">
            <h2><CloudUpload size={20} aria-hidden="true" /> Storage &amp; email</h2>
            <p><strong>{((details.storageBytes || 0) / 1024 ** 3).toFixed(2)} GiB</strong> stored or reserved for recordings.</p>
            <p>Private Cloudflare R2 storage and SMTP replay delivery.</p>
            <a className="sign-in" href="/admin">View connection status in Admin</a>
          </section>
          {account.isSuperAdmin && <section className="website-panel">
            <h2><SlidersHorizontal size={20} aria-hidden="true" /> Venue limits</h2>
            <form className="stack-form" key={JSON.stringify(details.limits)} onSubmit={event => void submit(event, "limits")}>
              <fieldset disabled={busy !== null}>
                <label>Maximum courts<input name="max_courts" type="number" min={1} step={1} defaultValue={details.limits?.max_courts ?? ""} /></label>
                <label>Maximum devices<input name="max_devices" type="number" min={1} step={1} defaultValue={details.limits?.max_devices ?? ""} /></label>
                <label>Storage limit in bytes<input name="storage_limit_bytes" type="number" min={1} step={1} defaultValue={details.limits?.storage_limit_bytes ?? ""} /></label>
              </fieldset>
              <p className="form-note">Leave a limit empty for unlimited. Lower limits apply to new allocations.</p>
              <button className="primary" disabled={busy !== null}>{busy === "limits" ? "Saving…" : "Save limits"}</button>
            </form>
          </section>}
        </>
      )}
    </div>
  </>;
}
