import { androidRelease } from "@/lib/android-release";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";
export function GET() {
  try { return json(androidRelease()); }
  catch {
    return json({ error: "The Android update download is not configured. Contact your administrator." }, 503);
  }
}
