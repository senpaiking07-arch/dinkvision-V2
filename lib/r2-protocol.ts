export const R2_UPLOAD_PROTOCOL = "r2-multipart-v1";
export const R2_PART_SIZE = 8 * 1024 * 1024;
export const R2_MAX_BYTES = R2_PART_SIZE * 10000;

export type RemotePart = { PartNumber?: number; Size?: number; ETag?: string };

// Only storage-confirmed, contiguous parts advance the resume position. An
// undersized part is overwritten on retry; unexpected extra parts are rejected.
export function confirmedParts(parts: RemotePart[], bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > R2_MAX_BYTES) throw new Error("Invalid recording size.");
  const ordered = [...parts].sort((a,b) => (a.PartNumber || 0)-(b.PartNumber || 0));
  let offset = 0;
  const complete: { PartNumber: number; ETag: string }[] = [];
  const seen = new Set<number>();
  for (const part of ordered) {
    const n = part.PartNumber;
    if (!n || !Number.isInteger(n) || n < 1 || n > Math.ceil(bytes/R2_PART_SIZE) || seen.has(n))
      throw new Error("Invalid remote upload parts.");
    seen.add(n);
    if (n !== complete.length + 1 || part.Size !== Math.min(R2_PART_SIZE,bytes-offset) || !part.ETag) break;
    offset += part.Size;
    complete.push({PartNumber:n,ETag:part.ETag});
  }
  return { offset, parts: complete, uploaded: offset === bytes };
}

export function r2PartAddress(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname) ||
      url.port || url.username || url.password || url.hash || !url.searchParams.get("uploadId") ||
      !/^\d+$/.test(url.searchParams.get("partNumber") || "") || !url.searchParams.get("X-Amz-Signature"))
    throw new Error("Invalid private storage upload address.");
  return url.toString();
}
