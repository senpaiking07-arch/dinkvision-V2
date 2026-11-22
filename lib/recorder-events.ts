import { InputError, uuid } from "./validation";

export const stages = {
  start_tap:"Start pressed on the player screen", start_accepted:"Start accepted by the recorder",
  stop_requested:"Stop requested", start_repeated:"Repeated Start presses ignored", stop_repeated:"Repeated Stop presses ignored",
  work_queue:"Waiting for the device worker", release_check:"Checking the approved APK version",
  reconcile:"Checking the court and previous capture", reserve:"Reserving the recording on the server",
  camera_prepare:"Camera preparation before countdown", camera_connect:"Opening camera and waiting for frames",
  microphone_prepare:"Configuring microphone routing", encoder_prepare:"Preparing encoder and watermark", countdown:"Three-second countdown",
  capture:"Recording on the device", finalize:"Finalizing the video",
  validate:"Checking saved video and logo integrity", saved_report:"Reporting the saved video",
  branding:"Adding the logo", transfer:"Uploading to cloud storage", verify:"Verifying cloud upload", queue_wait:"Waiting for the upload turn",
  cleanup:"Releasing the uploaded private copy", complete:"Completed",
} as const;
export const codes = {
  none:"No failure reported", timeout:"Network request timeout; the cause is not yet established",
  dns:"Server address could not be resolved", tls:"Secure connection validation failed",
  connection:"Connection failed or was interrupted", http_client:"Server rejected the request",
  http_server:"Server temporarily unavailable", validation:"Saved video validation failed",
  device_or_storage:"Device or storage operation failed", unknown:"No specific cause reported",
} as const;
export type RecorderEvent = {
  event_id:string; attempt_id:string; session_id:string|null; operation:"capture"|"upload";
  stage:keyof typeof stages; result:"ok"|"failed"|"waiting"; code:keyof typeof codes;
  elapsed_ms:number; duration_ms:number; occurred_at:string; queue_count:number; bytes:number;
  retry_count:number; version_code:number;
  action_source?:"player"|"notification"|"admin"|null; repeated_actions?:number|null;
  http_status?:number|null; acknowledged_bytes?:number|null; transferred_bytes?:number|null; retry_delay_ms?:number|null;
};
export function stageLabel(stage:string) { return stages[stage as keyof typeof stages] || "Unrecognized stage"; }
export function codeLabel(code:string) { return codes[code as keyof typeof codes] || codes.unknown; }
const fields = new Set(["event_id","attempt_id","session_id","operation","stage","result","code",
  "elapsed_ms","duration_ms","occurred_at","queue_count","bytes","retry_count","version_code",
  "http_status","acknowledged_bytes","transferred_bytes","retry_delay_ms","action_source","repeated_actions"]);
export function parseRecorderEvents(value:unknown):RecorderEvent[] {
  if (!Array.isArray(value) || !value.length || value.length>20) throw new InputError("Send 1–20 diagnostic events.");
  const seen = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw!=="object" || Array.isArray(raw) || Object.keys(raw).some(key=>!fields.has(key)))
      throw new InputError("Invalid diagnostic fields.");
    const e=raw as RecorderEvent;
    const integer=(n:unknown,max:number)=> typeof n==="number" && Number.isSafeInteger(n) && n>=0 && n<=max;
    const metrics = [["http_status", 599], ["acknowledged_bytes", 1e12],
      ["transferred_bytes", 1e12], ["retry_delay_ms", 604800000]] as const;
    for (const [field, limit] of metrics)
      if (e[field] != null && (!integer(e[field], limit) || (field === "http_status" && e[field]! < 100)))
        throw new InputError("Invalid diagnostic metrics.");
    if (e.action_source != null && !["player", "notification", "admin"].includes(e.action_source))
      throw new InputError("Invalid recorder action source.");
    if (e.repeated_actions != null && (!integer(e.repeated_actions, 1000) || e.repeated_actions < 1))
      throw new InputError("Invalid repeated action count.");
    const event_id=uuid(e.event_id),attempt_id=uuid(e.attempt_id),session_id=e.session_id===null?null:uuid(e.session_id);
    if (seen.has(event_id)) throw new InputError("Duplicate diagnostic event.");
    seen.add(event_id);
    if (!Object.hasOwn(stages,e.stage) || !Object.hasOwn(codes,e.code)
      || !["capture","upload"].includes(e.operation) || !["ok","failed","waiting"].includes(e.result)
      || (e.result==="failed" && e.code==="none")
      || !integer(e.elapsed_ms,604800000) || !integer(e.duration_ms,604800000)
      || !integer(e.queue_count,10000) || !integer(e.bytes,1e12) || !integer(e.retry_count,1000)
      || !integer(e.version_code,2147483647) || typeof e.occurred_at!=="string"
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.occurred_at)
      || !Number.isFinite(Date.parse(e.occurred_at))) throw new InputError("Invalid diagnostic values.");
    return {...e,event_id,attempt_id,session_id};
  });
}
