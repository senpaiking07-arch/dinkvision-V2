import "server-only";
import { recorderDatabase } from "./recorder-server";
import { r2Store } from "./r2-server";
import { signReplay, verifyReplay } from "./replay-token";
import { recordingDownloadFilename, type RecordingFilenameMetadata } from "./recording-filename";

export const replayStorageFields = "id,session_id,storage_provider,storage_bucket,storage_key,expires_at";
export const replayDownloadFields =
  `${replayStorageFields},recording_sessions(started_at,venue_time_zone:configuration_snapshot->>venue_time_zone)` as const;

export function replayLink(tenant:string,file:string,expires:string) {
  const origin=new URL(process.env.REPLAY_ORIGIN || process.env.APP_ORIGIN || "");
  if(origin.protocol!=="https:" && !(process.env.DINKVISION_LOCAL_TEST==="true" && origin.protocol==="http:"))
    throw new Error("Configure the player-accessible replay origin.");
  if(origin.username||origin.password||origin.pathname!=="/"||origin.search||origin.hash) throw new Error("Invalid replay origin.");
  const token=signReplay({v:1,tenant,file,exp:Math.floor(Date.parse(expires)/1000)},process.env.REPLAY_SIGNING_KEY || "");
  return `${origin.origin}/replay/${token}`;
}

export async function guestReplay(token:string, download = false) {
  const claims=verifyReplay(token,process.env.REPLAY_SIGNING_KEY || "");
  if(!claims) return null;
  const db=recorderDatabase(claims.tenant);
  const tenant=await db.from("tenants").select("id").eq("active",true).maybeSingle();
  if(tenant.error) throw new Error("Replay service is temporarily unavailable.");
  if(!tenant.data) return null;
  const files = db.from("recording_files");
  const query = download ? files.select(replayDownloadFields) : files.select(replayStorageFields);
  const result=await query
    .eq("id",claims.file).eq("storage_provider","r2").eq("status","ready")
    .is("deleted_at",null).gt("expires_at",new Date().toISOString()).maybeSingle();
  if(result.error) throw new Error("Replay service is temporarily unavailable.");
  return result.data ? {...result.data,expires_at:new Date(Math.min(Date.parse(result.data.expires_at),claims.exp*1000)).toISOString()} : null;
}

type PlaybackFile = {storage_bucket:string;storage_key:string;expires_at:string};

export class ReplayObjectMissing extends Error {}

function replayObject(file: PlaybackFile) {
  return {bucket:file.storage_bucket,object_key:file.storage_key,upload_id:null};
}

export async function checkReplayStorage(file: PlaybackFile) {
  if (!await r2Store().head(replayObject(file))) throw new ReplayObjectMissing();
}

export async function privatePlayback(file: RecordingFilenameMetadata & PlaybackFile,download=false) {
  if (Date.parse(file.expires_at) <= Date.now()) throw new Error("Replay expired.");
  await checkReplayStorage(file);
  const lifetime=Math.min(300,Math.floor((Date.parse(file.expires_at)-Date.now())/1000));
  if(lifetime<1) throw new Error("Replay expired.");
  return r2Store().playback(
    replayObject(file),
    download, lifetime, download ? recordingDownloadFilename(file) : undefined,
  );
}
