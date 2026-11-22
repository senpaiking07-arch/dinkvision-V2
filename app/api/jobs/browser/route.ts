import { timingSafeEqual } from "node:crypto";
import { runBrowserJobs } from "@/lib/browser-jobs";
import { json, sameOrigin } from "@/lib/http";
import { getAccount } from "@/lib/auth";
export const maxDuration = 60;
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET,
    provided = request.headers.get("authorization") || "";
  const desired = `Bearer ${expected}`;
  if (
    !expected ||
    Buffer.byteLength(provided) !== Buffer.byteLength(desired) ||
    !timingSafeEqual(Buffer.from(provided), Buffer.from(desired))
  )
    return json({ error: "Worker authentication required." }, 401);
  try {
    return json(await runBrowserJobs());
  } catch {
    return json(
      { error: "Background processing failed; retry scheduled." },
      503,
    );
  }
}
export async function POST(request: Request) {
  const {account}=await getAccount();
  if (!sameOrigin(request) || account?.role !== "admin" || !account.tenantId)
    return json({ error: "Admin access required." }, 403);
  try {
    return json(await runBrowserJobs(account.tenantId));
  } catch {
    return json(
      {
        error:
          "Background processing failed. Check storage and email connections, then retry.",
      },
      503,
    );
  }
}
