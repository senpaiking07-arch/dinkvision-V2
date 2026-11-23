import "server-only";
import { cache } from "react";
import { isConfigured, serverSupabase } from "./supabase-server";
import { cookies } from "next/headers";
import { TENANT_COOKIE } from "./tenant-scope";
import { selectAccountTenant } from "./account-tenant";

export type Account = {
  id: string;
  email: string;
  displayName: string;
  role: "player" | "admin";
  tenantId?: string;
  tenants?: {id: string; name: string; role: string}[];
  isSuperAdmin?: boolean;
  tenantName?: string;
};

export const getAccount = cache(
  async (): Promise<{ account: Account | null; problem?: string }> => {
    if (!isConfigured())
      return {
        account: null,
        problem: "Account service is not configured yet.",
      };
    const db = await serverSupabase();
    const {
      data: { user },
      error,
    } = await db.auth.getUser();
    if (error || !user) return { account: null };
    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("display_name,role,active,is_super_admin")
      .eq("id", user.id)
      .single();
    if (profileError)
      return {
        account: null,
        problem:
          "Your account profile is not ready. Please contact the venue administrator.",
      };
    if (!profile?.active || !user.email_confirmed_at)
      return {
        account: null,
        problem: "This account is inactive or its email has not been verified.",
      };
    if (profile.role !== "player" && profile.role !== "admin")
      return { account: null, problem: "Account role is not valid." };
    const membership = await db.from("tenant_memberships")
      .select("role,tenants!inner(id,name,active)")
      .eq("user_id", user.id).eq("active", true);
    if (membership.error) return { account: null, problem: "Venue access could not be verified. Please try again." };
    let tenants = (membership.data || []).flatMap(row => {
      const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
      return tenant?.active && ["admin", "player"].includes(row.role)
        ? [{ id: tenant.id, name: tenant.name, role: row.role as "admin" | "player" }] : [];
    });
    if (profile.is_super_admin) {
      const available = await db.from("tenants").select("id,name").eq("active", true).order("name");
      if (available.error) return { account: null, problem: "Venue access could not be verified. Please try again." };
      tenants = (available.data || []).map(t => ({ ...t, role: "admin" as const }));
    }
    const selected = selectAccountTenant(tenants, (await cookies()).get(TENANT_COOKIE)?.value);
    return {
      account: {
        id: user.id,
        email: user.email!,
        displayName: profile.display_name,
        role: selected?.role || "player",
        tenantId: selected?.id,
        tenantName: selected?.name,
        tenants,
        isSuperAdmin: profile.is_super_admin === true,
      },
    };
  },
);
