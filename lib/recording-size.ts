// Match the Android saved-video display (1 MB = 1024 * 1024 bytes).
export function recordingSizeMb(bytes:unknown) {
  const size=typeof bytes==='number'||typeof bytes==='string'?Number(bytes):NaN;
  return Number.isFinite(size)&&size>0 ? `${(size/1048576).toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1})} MB` : 'Size not reported yet';
}
export function uploadSizeMb(uploaded:unknown,total:unknown) {
  const bytes=Number(total),done=Number(uploaded);
  if(!Number.isFinite(bytes)||bytes<=0)return recordingSizeMb(total);
  if (uploadPercent(uploaded, total) === undefined) return `Video size · ${recordingSizeMb(total)}`;
  return `${(Math.max(0,Math.min(bytes,Number.isFinite(done)?done:0))/1048576).toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1})} / ${recordingSizeMb(bytes)} uploaded`;
}

export function uploadPercent(uploaded: unknown, total: unknown): number | undefined {
  const count = (value: unknown) => typeof value === "number" || typeof value === "string" && value.trim()
    ? Number(value) : NaN;
  const sent = count(uploaded), size = count(total);
  if (!Number.isFinite(sent) || !Number.isFinite(size) || size <= 0) return undefined;
  return Math.max(0, Math.min(100, Math.floor(sent * 100 / size)));
}
