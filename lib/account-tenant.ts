export type AccountTenant = { id: string; name: string; role: "admin" | "player" };

// Cookie values select from server-verified active memberships, never confer access.
export function selectAccountTenant(tenants: AccountTenant[], requested?: string) {
  return tenants.find(tenant => tenant.id === requested) ||
    [...tenants].sort((a, b) => a.id.localeCompare(b.id))[0];
}
