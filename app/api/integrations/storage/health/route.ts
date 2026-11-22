import { getAccount } from "@/lib/auth";
import { json } from "@/lib/http";
import { storageHealth } from "@/lib/storage-health";
import { smtpConfig, smtpHealth } from "@/lib/smtp";

export async function POST() {
  const { account } = await getAccount();
  if (account?.role !== "admin" || !account.tenantId) return json({ error: "Administrator access required." }, 403);
  let smtpConfigured = false;
  let smtpFrom = "";
  try { const c = smtpConfig(); smtpConfigured = true; smtpFrom = c.from; } catch {}
  const [storage, smtp] = await Promise.all([storageHealth(true), smtpHealth()]);
  return json({
    ...storage,
    provider: "r2",
    storage,
    smtp: { ...smtp, configured: smtpConfigured, from: smtpFrom },
    message: storage.ready ? (smtp.ready ? "R2 storage and SMTP email are connected." : "R2 storage is connected. SMTP email needs attention.") : "R2 storage could not be checked.",
  });
}
