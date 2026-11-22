import { R2_UPLOAD_PROTOCOL, normalizePartSize, r2PartAddress } from "./r2-protocol";

type Grant = {protocol:string;attemptId:string;bytes:number;mime:string;partSize:number};
type Reply = {ready?:boolean;queued?:boolean;expired?:boolean;uploaded?:boolean;offset?:number;url?:string;length?:number;upload?:Grant};

export async function sendR2Video(options: {
  id:string;bytes:number;grant:Grant;
  request:(action:string,fields:Record<string,unknown>)=>Promise<Reply>;
  restart:()=>Promise<Reply>;
  range:(start:number,end:number)=>Promise<Blob>;
  progress:(confirmedBytes:number)=>Promise<void>;
  transport?:typeof fetch;
}) {
  let grant=options.grant,restarts=0,previous=-1,stalled=0;
  const request=(action:string,fields:Record<string,unknown>={})=>options.request(action,{
    id:options.id,attempt_id:grant.attemptId,upload_protocol:R2_UPLOAD_PROTOCOL,...fields,
  });
  while (true) {
    const partSize = normalizePartSize(grant?.partSize);
    if (grant?.protocol!==R2_UPLOAD_PROTOCOL || grant.bytes!==options.bytes || grant.partSize!==partSize || grant.mime!=="video/mp4")
      throw new Error("Storage upload does not match the saved recording.");
    const status=await request("upload-status");
    if(status.queued) throw new Error("Upload is paused or waiting for another device. The local recording is retained.");
    if(status.ready || status.uploaded) break;
    if(status.expired) {
      if(++restarts>2) throw new Error("Upload expired. Retry the saved video.");
      const restarted=await options.restart();
      if(restarted.ready) return;
      if(!restarted.upload) throw new Error("Upload restart did not return a valid session.");
      grant=restarted.upload; previous=-1; continue;
    }
    const offset=status.offset;
    if(!Number.isSafeInteger(offset) || offset!<0 || offset!>=options.bytes || offset!%partSize!==0)
      throw new Error("Invalid confirmed upload progress.");
    if(offset===previous) { if(++stalled>2) throw new Error("Upload stalled. Retry the saved video."); }
    else stalled=0;
    previous=offset!;
    await options.progress(offset!);
    const part=await request("upload-part",{part_number:offset!/partSize+1});
    if(part.uploaded) break;
    const length=Math.min(partSize,options.bytes-offset!);
    if(part.offset!==offset || part.length!==length || !part.url) throw new Error("Upload progress changed. Retry the saved video.");
    const chunk=await options.range(offset!,offset!+length);
    if(chunk.size!==length) throw new Error("Saved video data is incomplete.");
    const address=r2PartAddress(part.url);
    let response:Response;
    try {
      response=await (options.transport || fetch)(address,{
        method:"PUT",body:chunk,credentials:"omit",redirect:"error",referrerPolicy:"no-referrer",
        // Preserve the normal timeout for 32 MiB parts and give larger parts
        // more time to finish on slower uplinks.
        signal:AbortSignal.timeout(Math.max(90000, Math.ceil(length / (32 * 1024 * 1024)) * 30000)),
      });
    } catch { throw new Error("Upload connection interrupted. The local recording is retained."); }
    if(!response.ok) throw new Error("Storage did not accept this part. Retry the saved video.");
    // The next server status request confirms acceptance; PUT alone never
    // releases the saved recording or marks the upload complete.
  }
  if(!(await request("finish")).ready) throw new Error("Upload confirmation is pending. The local backup is retained.");
  await options.progress(options.bytes);
}
