import sharp from "sharp";
import { InputError } from "./validation";

export const maxLogoUploadBytes = 2 * 1024 * 1024;
const maxLogoBytes = 512 * 1024;
const formats = new Set(["png", "webp", "jpeg"]);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function isAnimatedPng(input: Buffer) {
  if (!input.subarray(0, 8).equals(pngSignature)) return false;
  for (let offset = 8; offset + 12 <= input.length;) {
    const type = input.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL") return true;
    offset += 12 + input.readUInt32BE(offset);
  }
  return false;
}

export async function normalizeCourtLogo(request: Request) {
  if (Number(request.headers.get("content-length")) > maxLogoUploadBytes)
    throw new InputError("Choose an image up to 2 MB.");
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("Choose an image to upload.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxLogoUploadBytes) {
      await reader.cancel();
      throw new InputError("Choose an image up to 2 MB.");
    }
    chunks.push(value);
  }
  try {
    const input = Buffer.concat(chunks, bytes);
    const image = sharp(input, { limitInputPixels: 4_000_000, failOn: "warning" });
    const metadata = await image.metadata();
    if (!metadata.format || !formats.has(metadata.format) || (metadata.pages ?? 1) > 1 || isAnimatedPng(input))
      throw new InputError("Choose a still PNG, WebP, or JPEG image.");
    const png = await image.autoOrient().resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 }).toBuffer();
    if (png.length > maxLogoBytes) throw new InputError("This logo is too detailed. Try a simpler or smaller image.");
    return png;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("Choose a valid image with no more than 4 megapixels.");
  }
}

export function courtLogoResponse(value: string | Buffer) {
  const png = typeof value === "string" ? Buffer.from(value.slice(2), "hex") : value;
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
