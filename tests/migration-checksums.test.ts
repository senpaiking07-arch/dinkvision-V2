import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { migrationChecksumMatches } from "../scripts/migration-checksums.mjs";

test("migration runner accepts only the audited ownership-grant bootstrap change", async () => {
  const name = "202610140036_tenant_isolation.sql";
  const old = "1ca9e9353cade1cf5d2dabcbed37c29b11fcd648a7517fa653b3a00692169ee8";
  const source = (await readFile(`supabase/migrations/${name}`, "utf8")).replaceAll("\r\n", "\n");
  const current = createHash("sha256").update(source).digest("hex");
  assert.equal(migrationChecksumMatches(name, old, current), true);
  assert.equal(migrationChecksumMatches("another.sql", old, current), false);
  assert.equal(migrationChecksumMatches(name, old, "modified"), false);
  assert.equal(migrationChecksumMatches(name, "unrecognized", current), false);
  assert.equal(migrationChecksumMatches("another.sql", "same", "same"), true);
});
