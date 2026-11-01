// Migration 036 was historically applied before commit 9eb79ef added only a
// GRANT to the executing migration role for fresh Supabase installations.
// Both exact files are known; retain the original ledger entry and never rerun
// the tenant migration. Any other change still fails checksum verification.
const historical = {
  "202610140036_tenant_isolation.sql": {
    applied: "1ca9e9353cade1cf5d2dabcbed37c29b11fcd648a7517fa653b3a00692169ee8",
    current: "9ded7808f7fc5e7713e84a5af4615da628758fdce6a32445685fbd61c67c08b4",
  },
};

export function migrationChecksumMatches(name, applied, current) {
  if (applied === current) return true;
  const known = historical[name];
  return !!known && known.applied === applied && known.current === current;
}
