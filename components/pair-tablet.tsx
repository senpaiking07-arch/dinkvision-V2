"use client";
import { useRef, useState, type FormEvent } from "react";

type Device = { id: string; name: string; courtId: string; court: string };

export default function PairTablet({ requestId, devices }: { requestId: string; devices: Device[] }) {
  const [pin, setPin] = useState("");
  const [selected, setSelected] = useState("");
  const [replace, setReplace] = useState(false);
  const [replacementRequired, setReplacementRequired] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const device = devices.find(choice => choice.id === selected);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const decline = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "decline";
    if (submitting.current || !/^\d{6}$/.test(pin) || (!decline && (!device || (replacementRequired && !replace)))) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/tablet-pairing", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: requestId, pin, device: device?.id, court: device?.courtId,
          action: decline ? "decline" : "approve", replace }),
      });
      const data = await response.json();
      if (!response.ok) {
        setReplacementRequired(data.replacementRequired === true);
        setError(data.error || "Pairing could not be approved.");
      } else {
        setResult(data.status === "declined" ? "Pairing declined."
          : data.status === "enrolled" ? "The tablet is already paired." : "Pairing approved. The tablet can now finish connecting.");
      }
    } catch {
      setError("Connection interrupted. Retry with the same pairing number.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (result) return <p role="status">{result}</p>;
  return <form className="stack-form" onSubmit={submit}>
    <label>Tablet pairing number
      <input inputMode="numeric" pattern="[0-9]{6}" autoComplete="off" maxLength={6} required disabled={busy}
        value={pin} onChange={event => setPin(event.target.value.replace(/[^0-9]/g, ""))} />
    </label>
    <label>Device and assigned court
      <select value={selected} disabled={busy} onChange={event => {
        setSelected(event.target.value); setReplace(false); setReplacementRequired(false);
      }}>
        <option value="">Choose a device and court</option>
        {devices.map(choice => <option key={choice.id} value={choice.id}>{choice.name} · {choice.court}</option>)}
      </select>
    </label>
    {!devices.length && <p>Assign an enabled device to an active court in Devices & cameras first.</p>}
    {replacementRequired && <label>
      <input type="checkbox" checked={replace} disabled={busy} onChange={event => setReplace(event.target.checked)} />
      Confirm replacement of the existing registration
    </label>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="primary" disabled={busy || !device || (replacementRequired && !replace)}>Approve pairing</button>
    {requestId && <button type="submit" value="decline" disabled={busy}>Decline request</button>}
  </form>;
}
