"use client";
import { useEffect, useRef, useState } from "react";
import { pairingBrowserLinks } from "@/lib/tablet-enrollment";

export default function PairingBrowserFallback({ path }: { path: string }) {
  const [browserLink, setBrowserLink] = useState(path);
  const [copyStatus, setCopyStatus] = useState("");
  const linkField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setBrowserLink(pairingBrowserLinks(path, window.location.origin, /Android/i.test(navigator.userAgent)).external);
  }, [path]);

  async function copyLink() {
    const url = pairingBrowserLinks(path, window.location.origin, false).page;
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus("Pairing link copied. Paste it into your browser.");
    } catch {
      if (linkField.current) {
        linkField.current.hidden = false;
        linkField.current.value = url;
        linkField.current.focus();
        linkField.current.select();
      }
      setCopyStatus("Copy the selected link and paste it into your browser.");
    }
  }

  return <details className="recorder-disclosure admin-pairing-help">
    <summary>Trouble signing in from your scanner?</summary>
    <p>Choose Open in browser from your scanner menu. You can also copy this link and open it in Safari, Chrome, or your preferred browser.</p>
    <div className="recorder-workspace-actions">
      <a className="sign-in" href={browserLink} target="_blank" rel="noopener noreferrer">Open in external browser</a>
      <button type="button" className="secondary" onClick={() => void copyLink()}>Copy pairing link</button>
    </div>
    <input ref={linkField} aria-label="Pairing link" readOnly hidden />
    <p role="status">{copyStatus}</p>
  </details>;
}
