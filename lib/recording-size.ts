// Match the Android saved-video display (1 MB = 1024 * 1024 bytes).
export function recordingSizeMb(bytes:unknown) {
  const size=typeof bytes==='number'||typeof bytes==='string'?Number(bytes):NaN;
  return Number.isFinite(size)&&size>0 ? `${(size/1048576).toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1})} MB` : 'Size not reported yet';
}
export function uploadSizeMb(uploaded:unknown,total:unknown) {
  const bytes=Number(total),done=Number(uploaded);
  if(!Number.isFinite(bytes)||bytes<=0)return recordingSizeMb(total);
  return `${(Math.max(0,Math.min(bytes,Number.isFinite(done)?done:0))/1048576).toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1})} / ${recordingSizeMb(bytes)} uploaded`;
}
