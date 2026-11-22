import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const [emailInput, role = "player", displayName = "", tenantId] = process.argv.slice(2);
const email = emailInput?.trim().toLowerCase();
if (
  !email ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
  !["admin", "player"].includes(role) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId || "")
) {
  console.error(
    'Usage: npm run account:create:r2 -- email@example.com player|admin "Display name" TENANT_UUID',
  );
  process.exit(1);
}
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY)
  throw new Error("Configure the Supabase URL and server secret key locally.");
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const password = randomBytes(24).toString("base64url");
const tenant = await db.from("tenants").select("id").eq("id", tenantId).eq("active", true).single();
if (tenant.error) throw new Error("Choose an existing active tenant before creating an account.");
// Seed only owner-confirmed test addresses. No email is sent and existing passwords are never reset.
const { data, error } = await db.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
if (error) {
  console.error("Account creation failed:", error.code || error.status);
  process.exit(1);
}
const { error: profileError } = await db
  .from("profiles")
  .upsert({ id: data.user.id, display_name: displayName, role, active: true });
const membership = profileError ? { error: profileError } : await db.from("tenant_memberships")
  .upsert({ tenant_id: tenantId, user_id: data.user.id, role, active: true });
await mkdir(".local", { recursive: true });
const path = `.local/account-${data.user.id}.json`;
await writeFile(
  path,
  JSON.stringify(
    { email, password, role, tenantId, profileReady: !profileError, membershipReady: !membership.error },
    null,
    2,
  ),
  { mode: 0o600, flag: "wx" },
);
if (profileError || membership.error) {
  console.error(
    "Auth account created, but profile or membership setup failed. Saved credentials locally; repair access before sign-in.",
  );
  process.exitCode = 1;
} else console.log("Account created. Credentials saved locally at", path);
