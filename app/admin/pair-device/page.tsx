import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import PairTablet from "@/components/pair-tablet";
import PairingBrowserFallback from "@/components/pairing-browser-fallback";
import { WebsiteMessage } from "@/components/website-frame";
import { getAccount } from "@/lib/auth";
import { recorderDatabase } from "@/lib/recorder-server";
import { serverSupabase } from "@/lib/supabase-server";
import { DEFAULT_TENANT_ID, TENANT_COOKIE } from "@/lib/tenant-scope";
import { uuid } from "@/lib/validation";

export const metadata: Metadata = {
  title: "Pair a tablet · DinkVision",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function PairDevicePage({ searchParams }: {
  searchParams: Promise<{ request?: string | string[] }>;
}) {
  let requestId = "";
  try { requestId = uuid((await searchParams).request); } catch { }
  if (!requestId) redirect("/admin");
  const { account } = await getAccount();
  const path = `/admin/pair-device?request=${requestId}`;
  if (!account) return <WebsiteMessage title="Pair a tablet">
      <p>Sign in with your venue administrator account to approve the tablet.</p>
      <p><a className="primary" href={`/admin/login?pair=${requestId}`}>Sign in to Admin</a></p>
      <PairingBrowserFallback path={path} />
  </WebsiteMessage>;
  if (account.role !== "admin") redirect("/");
  const selected = (await cookies()).get(TENANT_COOKIE)?.value;
  const tenant = selected ? uuid(selected) : DEFAULT_TENANT_ID;
  const authorization = await (await serverSupabase(tenant)).rpc("is_admin");
  if (authorization.data !== true) redirect("/admin");
  const db = recorderDatabase(tenant);
  const [devices, courts] = await Promise.all([
    db.from("browser_devices").select("id,name,court_id").eq("enabled", true).order("name"),
    db.from("courts").select("id,name").eq("active", true).order("name"),
  ]);
  const activeCourts = new Map((courts.data || []).map(court => [court.id, court.name]));
  const choices = (devices.data || []).flatMap(device => {
    const court = activeCourts.get(device.court_id);
    return court ? [{ id: device.id, name: device.name, courtId: device.court_id, court }] : [];
  });
  return <WebsiteMessage title="Pair a tablet">
      <p>Match the six digits on the tablet. Select the device and court you intend to activate.</p>
      {devices.error || courts.error ? <p role="alert">Device assignments are unavailable. Reload to try again.</p>
        : <PairTablet requestId={requestId} devices={choices} />}
      <PairingBrowserFallback path={path} />
      <p><a className="sign-in" href="/admin">Back to Admin</a></p>
  </WebsiteMessage>;
}
