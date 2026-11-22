import { browserTablet } from "@/lib/browser-tablets";
import { json, sameOrigin } from "@/lib/http";

export async function PUT(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Invalid origin." }, 403);
  if (!await browserTablet()) return json({error:"Enroll this browser first."},401);
  return json({error:"Update this recorder to use private multipart uploads. The saved video is retained."},426);
}
