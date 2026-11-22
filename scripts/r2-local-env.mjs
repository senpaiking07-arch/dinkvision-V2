import { readFile, readdir } from "node:fs/promises";
import { parseEnv } from "node:util";

export const TEST_PROJECT = "gwermdkkrotvvpoxkqdx";
export const TEST_BUCKET = "dinkvision-videos-dev";

export function localOrigin(value) {
  try {
    const url = new URL(value);
    const host = url.hostname;
    const privateIp = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(host);
    return ["http:", "https:"].includes(url.protocol) &&
      (["localhost", "127.0.0.1", "[::1]"].includes(host) || privateIp) &&
      !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch { return false; }
}

export function validateTestEnvironment(env, command) {
  if (env.NEXT_PUBLIC_SUPABASE_URL !== `https://${TEST_PROJECT}.supabase.co`)
    throw new Error(`Local testing requires Supabase project ${TEST_PROJECT}.`);
  if (env.R2_BUCKET !== TEST_BUCKET || env.R2_ACCOUNT_ID !== "42c7c9ce788292c080caf0ad3e8daded")
    throw new Error("Local testing requires the DinkVision development R2 bucket.");
  if (!localOrigin(env.APP_ORIGIN) || !localOrigin(env.REPLAY_ORIGIN))
    throw new Error("APP_ORIGIN and REPLAY_ORIGIN must be localhost or a private LAN origin.");
  const required = command === "migrate" ? ["MIGRATION_DATABASE_URL"] : command === "build" ? ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] :
    ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "TOKEN_ENCRYPTION_KEY", "REPLAY_SIGNING_KEY", "CRON_SECRET"];
  for (const key of required) if (!env[key]) throw new Error(`Set ${key} in .local/r2-test.env.`);
  for (const key of ["DATABASE_URL", "MIGRATION_DATABASE_URL"]) {
    if (!env[key]) continue;
    const url = new URL(env[key]);
    if (!["postgres:", "postgresql:"].includes(url.protocol) ||
        !(url.hostname === `db.${TEST_PROJECT}.supabase.co` ||
          (url.hostname.endsWith(".pooler.supabase.com") && decodeURIComponent(url.username) === `postgres.${TEST_PROJECT}`)))
      throw new Error(`${key} must target the isolated test project.`);
  }
  if (env.GOOGLE_REDIRECT_URI && env.GOOGLE_REDIRECT_URI !== `${env.APP_ORIGIN}/api/integrations/google/callback`)
    throw new Error("Google callback must use this local APP_ORIGIN.");
}

/** @returns {Promise<Record<string, string | undefined>>} */
export async function loadTestEnvironment(command, root = process.cwd()) {
  const { resolve } = await import("node:path");
  const local = parseEnv(await readFile(resolve(root, ".local/r2-test.env"), "utf8"));
  validateTestEnvironment(local, command);
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env };
  // Next loads .env automatically. Blank every application key before it runs,
  // including unknown keys in existing .env files, so omitted test values cannot
  // silently fall back to credentials from another project.
  for (const name of await readdir(root)) {
    if (!/^\.env(?:\.|$)/.test(name)) continue;
    const values = parseEnv(await readFile(resolve(root, name), "utf8"));
    for (const key of Object.keys(values)) env[key] = "";
  }
  for (const key of Object.keys(env)) {
    if (/^(NEXT_PUBLIC_|SUPABASE_|R2_|GOOGLE_|DATABASE_|MIGRATION_|ANDROID_|RECORDER_|REPLAY_)/.test(key) ||
        ["APP_ORIGIN", "CRON_SECRET", "TOKEN_ENCRYPTION_KEY", "VENUE_TIME_ZONE"].includes(key)) env[key] = "";
  }
  return { ...env, ...local, DINKVISION_LOCAL_TEST: "true", RECORDING_STORAGE_PROVIDER: "r2" };
}
