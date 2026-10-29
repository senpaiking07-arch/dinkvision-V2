import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";

const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString)
  throw new Error("Set MIGRATION_DATABASE_URL in .env.");
const ca =
  process.env.DATABASE_CA_CERT?.replaceAll("\\n", "\n") ||
  (process.env.DATABASE_CA_CERT_PATH
    ? await readFile(process.env.DATABASE_CA_CERT_PATH, "utf8")
    : undefined);
const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
  connectionTimeoutMillis: 10000,
});
let currentMigration;
try {
  await client.connect();
  await client.query("select pg_advisory_lock(72105631)");
  await client.query("create schema if not exists casa_migrations");
  await client.query(
    "create table if not exists casa_migrations.applied (name text primary key, checksum text not null, applied_at timestamptz not null default now())",
  );
  for (const name of (await readdir("supabase/migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    currentMigration = name;
    const sql = await readFile(`supabase/migrations/${name}`, "utf8");
    const checksum = createHash("sha256")
      .update(sql.replaceAll("\r\n", "\n"))
      .digest("hex");
    const { rows } = await client.query(
      "select checksum from casa_migrations.applied where name=$1",
      [name],
    );
    if (rows.length) {
      if (rows[0].checksum !== checksum)
        throw new Error(
          "An applied migration was modified; restore it and add a new migration.",
        );
      console.log("Already applied:", name);
      currentMigration = undefined;
      continue;
    }
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(
        "insert into casa_migrations.applied(name,checksum) values($1,$2)",
        [name, checksum],
      );
      await client.query("commit");
      console.log("Applied:", name);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
    currentMigration = undefined;
  }
  await client.query("notify pgrst, 'reload schema'");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `Migration failed${currentMigration ? ` (${currentMigration})` : ""}:`,
    message,
  );
  if (error && typeof error === "object" && "code" in error && error.code)
    console.error("PostgreSQL error code:", error.code);
  if (error && typeof error === "object" && "detail" in error && error.detail)
    console.error("Detail:", error.detail);
  if (error && typeof error === "object" && "hint" in error && error.hint)
    console.error("Hint:", error.hint);
  process.exitCode = 1;
} finally {
  await client.end();
}
