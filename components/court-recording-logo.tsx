"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Image as ImageIcon } from "lucide-react";

export default function CourtRecordingLogo({ courtId }: { courtId: string }) {
  const endpoint = `/api/admin/courts/${courtId}/recording-logo`;
  const [logo, setLogo] = useState<Blob | null>(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!logo) { setPreview(""); return; }
    const url = URL.createObjectURL(logo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [logo]);

  async function change(method: "GET" | "POST" | "DELETE", file?: File, signal?: AbortSignal) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(endpoint, {
        method, body: file, cache: "no-store",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "The logo could not be updated. Try again.");
      }
      setLogo(method === "DELETE" || response.status === 204 ? null : await response.blob());
      setLoaded(true);
      if (input.current) input.current.value = "";
      if (method !== "GET") setNotice(method === "DELETE" ? "Logo removed for future recordings." : "Logo saved for future recordings.");
    } catch (failure) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : "Could not load the recording logo.");
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void change("GET", undefined, controller.signal);
    return () => controller.abort();
  }, [endpoint]);

  function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const image = input.current?.files?.[0];
    if (!image || busy) return;
    if (image.size > 2 * 1024 * 1024) {
      setError("Choose an image up to 2 MB.");
      return;
    }
    void change("POST", image);
  }

  return <section className="recorder-facts court-logo-panel" aria-label="Recording logo" aria-busy={busy}>
    <h4><ImageIcon size={17} aria-hidden="true" /> Recording logo</h4>
    <p>Add a logo to the bottom left of future recordings on this court.</p>
    <div className="court-logo-preview" aria-label="Recording watermark preview">
      <span className="court-logo-preview-frame">
        {preview && <img src={preview} alt="Custom recording logo" />}
      </span>
      <span className="court-logo-preview-frame">
        <img src="/dink-vision-logo.png" alt="DinkVision watermark" />
      </span>
    </div>
    {loaded && <form className="stack-form" onSubmit={upload}>
      <label>
        Logo image
        <input ref={input} type="file" accept="image/png,image/webp,image/jpeg" disabled={busy} required />
        <span className="form-note">PNG, WebP, or JPEG up to 2 MB. Transparent areas are preserved.</span>
      </label>
      <div className="recorder-workspace-actions">
        <button className="secondary" disabled={busy}>{logo ? "Replace logo" : "Upload logo"}</button>
        {logo && <button type="button" className="secondary" disabled={busy} onClick={() => void change("DELETE")}>Remove logo</button>}
      </div>
    </form>}
    {busy && <p role="status">{loaded ? "Updating logo…" : "Loading logo…"}</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {!loaded && !busy && <button type="button" className="secondary" onClick={() => void change("GET")}>Retry logo check</button>}
  </section>;
}
