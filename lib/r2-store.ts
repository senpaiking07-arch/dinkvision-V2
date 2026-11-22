import {
  S3Client, HeadBucketCommand, CreateMultipartUploadCommand, UploadPartCommand,
  ListPartsCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
  HeadObjectCommand, GetObjectCommand, DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { RemotePart } from "./r2-protocol";

export type R2Object = { bucket: string; object_key: string; upload_id: string | null };
export class R2Store {
  constructor(readonly client: S3Client, readonly bucket: string) {}
  private target(object: R2Object) {
    if (object.bucket !== this.bucket || !object.object_key.startsWith("tenants/")) throw new Error("Storage identity mismatch.");
    return { Bucket: this.bucket, Key: object.object_key };
  }
  async healthy() { await this.client.send(new HeadBucketCommand({Bucket:this.bucket}), {abortSignal:AbortSignal.timeout(15000)}); }
  async create(object: R2Object, metadata: Record<string,string>) {
    const result = await this.client.send(new CreateMultipartUploadCommand({
      ...this.target(object), ContentType:"video/mp4", Metadata:metadata, CacheControl:"private, no-store",
    }), {abortSignal:AbortSignal.timeout(20000)});
    if (!result.UploadId) throw new Error("Storage did not return an upload identifier.");
    return result.UploadId;
  }
  async parts(object: R2Object) {
    const parts: RemotePart[] = [];
    let marker: string | undefined;
    const signal = AbortSignal.timeout(20000);
    for (let page=0; page<11; page++) {
      const result = await this.client.send(new ListPartsCommand({
        ...this.target(object),UploadId:object.upload_id!,PartNumberMarker:marker,MaxParts:1000,
      }), {abortSignal:signal});
      parts.push(...(result.Parts || []));
      if (!result.IsTruncated) return parts;
      if (!result.NextPartNumberMarker || result.NextPartNumberMarker === marker) throw new Error("Invalid storage pagination.");
      marker = result.NextPartNumberMarker;
    }
    throw new Error("Too many upload parts.");
  }
  async partUrl(object: R2Object, number: number, length: number) {
    return getSignedUrl(this.client, new UploadPartCommand({
      ...this.target(object),UploadId:object.upload_id!,PartNumber:number,ContentLength:length,
    }), {expiresIn:300});
  }
  async head(object: R2Object) {
    try { return await this.client.send(new HeadObjectCommand(this.target(object)), {abortSignal:AbortSignal.timeout(15000)}); }
    catch(error) { if (missingObject(error)) return null; throw error; }
  }
  async complete(object: R2Object, parts: {PartNumber:number;ETag:string}[]) {
    await this.client.send(new CompleteMultipartUploadCommand({
      ...this.target(object),UploadId:object.upload_id!,MultipartUpload:{Parts:parts},
    }), {abortSignal:AbortSignal.timeout(25000)});
  }
  async abort(object: R2Object) {
    if (!object.upload_id) return;
    try { await this.client.send(new AbortMultipartUploadCommand({...this.target(object),UploadId:object.upload_id}), {abortSignal:AbortSignal.timeout(15000)}); }
    catch(error) { if (!missingUpload(error)) throw error; }
  }
  async remove(object: R2Object) {
    await this.client.send(new DeleteObjectCommand(this.target(object)), {abortSignal:AbortSignal.timeout(15000)});
  }
  async playback(object: R2Object, download: boolean, expiresIn: number) {
    return getSignedUrl(this.client,new GetObjectCommand({
      ...this.target(object),ResponseContentType:"video/mp4",ResponseCacheControl:"private, no-store",
      ResponseContentDisposition:`${download ? "attachment" : "inline"}; filename="dinkvision-replay.mp4"`,
    }), {expiresIn});
  }
}
export function missingUpload(error: unknown) { return (error as {name?:string})?.name === "NoSuchUpload"; }
function missingObject(error: unknown) { return ["NotFound","NoSuchKey"].includes((error as {name?:string})?.name || ""); }
