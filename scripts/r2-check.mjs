import { createClient } from "@supabase/supabase-js";
import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import { loadTestEnvironment } from "./r2-local-env.mjs";

// Inspect the isolated configuration even when runtime credentials are absent.
// The build validation still enforces the exact test project/bucket and origins.
async function main() {
  const env = await loadTestEnvironment("build");
  let failures = 0;
  const required = ["SUPABASE_SECRET_KEY", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
    "TOKEN_ENCRYPTION_KEY", "REPLAY_SIGNING_KEY", "CRON_SECRET"];
  for (const key of required) {
    if (!env[key]) { console.log(`MISSING ${key}: set it in .local/r2-test.env`); failures++; }
  }
  console.log("PASS isolated test project, bucket and local origins");
  for (const key of ["TOKEN_ENCRYPTION_KEY", "REPLAY_SIGNING_KEY"]) {
    if (env[key] && Buffer.from(env[key], "base64").length !== 32) {
      console.log(`FAIL ${key}: must encode 32 bytes as base64`); failures++;
    }
  }
  if (env.SUPABASE_SECRET_KEY) {
    const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY,
      {auth:{persistSession:false,autoRefreshToken:false}});
    // Read only identifiers, never credentials, tokens or recording contents.
    for (const [table, columns] of [["tenants", "id"], ["r2_upload_attempts", "id"],
      ["recording_files", "id,storage_provider,storage_bucket,storage_key"], ["gmail_integrations", "tenant_id"]]) {
      try {
        const result = await db.from(table).select(columns).limit(1).abortSignal(AbortSignal.timeout(10000));
        if (result.error) throw new Error("read_failed");
        if (table === "tenants" && !result.data?.length) throw new Error("tenant_missing");
        console.log(`PASS Supabase server access: ${table}`);
      } catch { console.log(`FAIL Supabase ${table}: check test-project server key, schema and connectivity`); failures++; }
    }
  } else console.log("SKIP Supabase runtime access: server key missing");

  if (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
    const client = new S3Client({region:"auto",forcePathStyle:true,maxAttempts:1,
      endpoint:`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials:{accessKeyId:env.R2_ACCESS_KEY_ID,secretAccessKey:env.R2_SECRET_ACCESS_KEY},
      requestChecksumCalculation:"WHEN_REQUIRED",responseChecksumValidation:"WHEN_REQUIRED"});
    try {
      await client.send(new HeadBucketCommand({Bucket:env.R2_BUCKET}),{abortSignal:AbortSignal.timeout(10000)});
      console.log("PASS R2 bucket access (read-only; upload permission still requires a transfer test)");
    } catch { console.log("FAIL R2 bucket access: check S3 credentials, bucket permissions and connectivity"); failures++; }
    finally { client.destroy(); }
  } else console.log("SKIP R2 runtime access: access-key pair missing");

  const mail = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_SENDER_EMAIL"].filter(key=>!env[key]);
  console.log(mail.length ? `PENDING Gmail configuration: ${mail.join(", ")}; sender may instead be configured per tenant`
    : "PENDING Gmail: configuration present; tenant OAuth consent and delivery still require validation");
  console.log(failures ? "NOT READY: resolve the missing/failed checks before starting live storage tests."
    : "PREFLIGHT PASSED: run actual sign-in, upload, playback and recovery acceptance tests next.");
  process.exitCode = failures ? 1 : 0;
}

main().catch(() => {
  // Never print upstream errors: SDK errors can contain credentials or URLs.
  console.error("Preflight could not load the isolated configuration. Check .local/r2-test.env against the setup guide.");
  process.exitCode = 1;
});
