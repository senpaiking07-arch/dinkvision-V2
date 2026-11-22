import "server-only";
import { S3Client } from "@aws-sdk/client-s3";
import { R2Store } from "./r2-store";

export function usesR2() { return process.env.RECORDING_STORAGE_PROVIDER === "r2"; }

export function r2Store() {
  const account = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!account || !/^[a-f0-9]{32}$/.test(account) || !bucket || !accessKeyId || !secretAccessKey)
    throw new Error("Configure the server's R2 storage credentials.");
  return new R2Store(new S3Client({
    region:"auto",endpoint:`https://${account}.r2.cloudflarestorage.com`,forcePathStyle:true,
    credentials:{accessKeyId,secretAccessKey},maxAttempts:2,
    requestChecksumCalculation:"WHEN_REQUIRED",responseChecksumValidation:"WHEN_REQUIRED",
  }),bucket);
}
