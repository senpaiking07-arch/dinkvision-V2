// Emits a bounded, reviewable batch for Supabase MCP. Does not connect to a DB.
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { migrationSQL } from "./migration-role-compat.mjs";
const [offset = "0", count = "16"] = process.argv.slice(2);
const names = (await readdir("supabase/migrations")).filter(name => name.endsWith(".sql") && name < "20261118000000").sort();
const selected = names.slice(Number(offset), Number(offset) + Number(count));
let query = `create schema if not exists casa_migrations;
create table if not exists casa_migrations.applied(name text primary key,checksum text not null,applied_at timestamptz not null default now());\n`;
for (const name of selected) {
  const sql = (await readFile(`supabase/migrations/${name}`, "utf8")).replaceAll("\r\n", "\n");
  const checksum = createHash("sha256").update(sql).digest("hex");
  query += `\n-- ${name}\n${migrationSQL(sql)}\ninsert into casa_migrations.applied(name,checksum) values('${name}','${checksum}');\n`;
}
console.log(JSON.stringify({ total: names.length, names: selected, query }));
