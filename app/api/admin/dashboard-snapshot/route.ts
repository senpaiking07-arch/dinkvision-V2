import { getAccount } from "@/lib/auth";
import { loadAdminDashboard } from "@/lib/admin-dashboard-snapshot";
import { json, sameOrigin } from "@/lib/http";
import { serverSupabase } from "@/lib/supabase-server";
import { uuid } from "@/lib/validation";

async function authorize(request: Request) {
  if (process.env.DINKVISION_ADMIN_REALTIME !== "true") return json({}, 404);
  const { account } = await getAccount();
  if (!account) return json({}, 401);
  const query = new URL(request.url).searchParams;
  if (account.role !== "admin" || !account.tenantId ||
      account.tenantId !== query.get("tenant") || account.id !== query.get("account")) {
    return json({}, 403);
  }
  return { account, query };
}

export async function GET(request: Request) {
  const access = await authorize(request);
  if (access instanceof Response) return access;
  let focusedId = "";
  const recording = access.query.get("recording");
  try { if (recording) focusedId = uuid(recording); } catch { return json({}, 400); }
  const { failures, data } = await loadAdminDashboard(access.account.tenantId, focusedId);
  return failures.length ? json({}, 503) : json(data);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({}, 403);
  const access = await authorize(request);
  if (access instanceof Response) return access;
  const db = await serverSupabase(access.account.tenantId);
  // getAccount already verifies the cookie session with Auth and checks the venue role.
  const { data: { session } } = await db.auth.getSession();
  if (!session?.expires_at || session.user.id !== access.account.id) return json({}, 401);
  return json({ accessToken: session.access_token, expiresAt: session.expires_at });
}
