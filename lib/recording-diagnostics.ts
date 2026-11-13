import type{Session}from'./admin-types';
import { captureDurationLabel, captureInterruptionLabel } from "./capture-interruption";
const reasons:Record<string,string>={player_stop:'Stopped manually.',time_limit:'Reached the maximum recording duration.',interrupted:'Recording was interrupted.',capture_error:'The camera could not complete the recording.',storage_full:'The device ran out of recording space.',device_missing:'The camera became unavailable.',cancelled_before_start:'Cancelled before recording started.',short_recording:'Kept on the device because the clip is under one minute; it is not uploaded or emailed.',unsupported_format:'Kept on the device because its video format is not supported for upload.'};
const stages:Record<string,string>={capture:'Camera recording',browser_capture:'Camera recording / saved-video validation',upload:'Google Drive upload',sharing:'Google Drive sharing',upload_cancelled:'Upload cancelled',device_removed:'Device registration removed',short_recording:'No failure · local-only policy',unsupported_format:'Video format validation'};
const title=(value:string)=>value.replaceAll('_',' ').replace(/^./,s=>s.toUpperCase());
export function recordingDiagnostics(session:Pick<Session,'status'|'stop_reason'|'failure_stage'|'browser_recordings'|'capture_interruption_code'>){
 const report=Array.isArray(session.browser_recordings)?session.browser_recordings[0]:session.browser_recordings;
 const interruption=captureInterruptionLabel(session.capture_interruption_code);
 const detail=(report?.last_error||report?.safe_error||'').trim();
 const useful=detail&&!/^Adding (?:the )?Dink ?Vision logo\.?$/i.test(detail)?detail:'';
 const active=['requested','starting','recording','finalizing'].includes(session.status);
 const removed=session.failure_stage==='device_removed';
 const localOnly=['short_recording','unsupported_format'].includes(session.failure_stage||'');
 const stage=stages[session.failure_stage||'']||(session.failure_stage?title(session.failure_stage)
   : report?.branding_state==='failed'?'Logo processing / video validation'
   : report?.branding_state==='complete'&&['failed','retrying'].includes(report?.upload_state||'')?'Google Drive upload (device report)'
   : session.status==='ready'?'None reported · completed successfully':active?'Not applicable while recording':'Not reported');
 const reason=session.stop_reason ? reasons[session.stop_reason]||title(session.stop_reason)
   : removed?'The device registration associated with this recording was removed from Admin.'
   : localOnly?reasons[session.failure_stage!]
   : interruption?'Capture ended early.'
   : useful?useful
   : session.status==='ready'?'Completed successfully; the device did not report how recording was stopped.'
   : active?'Recording is still in progress.':'The device did not report a reason.';
 let help='';
 if(removed)help='Check the original device or an exported copy. Review its registration before retrying.';
 else if(report?.local_available===false&&session.status!=='ready')help='The private file is no longer available on the device. Check Gallery, Files or an exported backup.';
 else if(localOnly)help='Open Saved videos on the original device to play the local clip or save a separate Gallery / Files copy.';
 else if(session.status==='failed'||report?.upload_state==='retrying'||report?.upload_state==='failed')help='Open Saved videos on the original device to inspect the clip, save a device copy or retry.';
 return{reason,stage,detail:useful&&useful!==reason?useful:'',help,interruption,
  recoveredDuration: interruption ? captureDurationLabel(report?.duration_ms) : null};
}
