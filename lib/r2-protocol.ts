export const R2_UPLOAD_PROTOCOL = "r2-multipart-v1";
const MIB = 1024 * 1024;
export const R2_LEGACY_PART_SIZE = 8 * MIB;
export const R2_DEFAULT_PART_SIZE = 16 * MIB;
const STANDARD_PART_SIZES = [R2_LEGACY_PART_SIZE, R2_DEFAULT_PART_SIZE, 32 * MIB];
// Backward-compatible export: legacy default. New code should use attempt.part_size / R2_DEFAULT_PART_SIZE.
export const R2_PART_SIZE = R2_LEGACY_PART_SIZE;
export const R2_MAX_PARTS = 10000;
export const R2_MAX_BYTES = 5 * 1024 ** 4 - 5 * 1024 ** 3;
const R2_MAX_PART_SIZE = Math.ceil(R2_MAX_BYTES / (R2_MAX_PARTS * MIB)) * MIB;
export const R2_LEGACY_MAX_BYTES = STANDARD_PART_SIZES[2] * R2_MAX_PARTS;

export type RemotePart = { PartNumber?: number; Size?: number; ETag?: string };

export function normalizePartSize(value: unknown) {
  const size = Number(value);
  if (STANDARD_PART_SIZES.includes(size) || (size > STANDARD_PART_SIZES[2] && size <= R2_MAX_PART_SIZE && size % MIB === 0))
    return size;
  return R2_LEGACY_PART_SIZE;
}

export function uploadPartSize(bytes: number, preference: unknown) {
  if (bytes > R2_LEGACY_MAX_BYTES) return Math.ceil(bytes / (R2_MAX_PARTS * MIB)) * MIB;
  const preferred = normalizePartSize(preference ?? R2_DEFAULT_PART_SIZE);
  return STANDARD_PART_SIZES.find(size => size >= preferred && bytes <= size * R2_MAX_PARTS)
    ?? STANDARD_PART_SIZES[2];
}

// Only storage-confirmed, contiguous parts advance the resume position. An
// undersized part is overwritten on retry; unexpected extra parts are rejected.
export function confirmedParts(parts: RemotePart[], bytes: number, partSize = R2_LEGACY_PART_SIZE) {
  const size = normalizePartSize(partSize);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > R2_MAX_BYTES || bytes > size * R2_MAX_PARTS)
    throw new Error("Invalid recording size.");
  const totalParts = Math.ceil(bytes / size);
  const ordered = [...parts].sort((a, b) => (a.PartNumber || 0) - (b.PartNumber || 0));
  let offset = 0;
  const complete: { PartNumber: number; ETag: string }[] = [];
  const seen = new Set<number>();
  for (const part of ordered) {
    const n = part.PartNumber;
    if (!n || !Number.isInteger(n) || n < 1 || n > totalParts || seen.has(n))
      throw new Error("Invalid remote upload parts.");
    seen.add(n);
    if (n !== complete.length + 1 || part.Size !== Math.min(size, bytes - offset) || !part.ETag) break;
    offset += part.Size;
    complete.push({ PartNumber: n, ETag: part.ETag });
  }
  return { offset, parts: complete, uploaded: offset === bytes, partSize: size };
}

export function r2PartAddress(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname) ||
      url.port || url.username || url.password || url.hash || !url.searchParams.get("uploadId") ||
      !/^\d+$/.test(url.searchParams.get("partNumber") || "") || !url.searchParams.get("X-Amz-Signature"))
    throw new Error("Invalid private storage upload address.");
  return url.toString();
}
