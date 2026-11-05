type QueueRow={session_id:string;upload_state:string;branding_state?:string|null;client_created_at?:string|null;recording_sessions?:{created_at?:string|null}|null};
export function isQueuedWork(row:QueueRow){return ['saved_locally','queued','pending','retrying','uploading'].includes(row.upload_state);}
export function isLocalOnlyHistory(row:QueueRow & {last_error?:string|null;safe_error?:string|null;local_available?:boolean}){
 const policyNotice=(message?:string|null)=>!message
   || message==='Recording under one minute. Saved locally; no Drive upload or email.'
   || message==='Recording under one minute. Kept only on the original device.'
   || message.startsWith('This clip is under one minute, so it was not uploaded. It remains in the app-private backup directory ');
 return row.upload_state==='local_only' && row.local_available!==false
   && row.branding_state!=='processing' && row.branding_state!=='failed'
   && policyNotice(row.last_error) && policyNotice(row.safe_error);
}
export function visibleDeviceQueueItem(row: {upload_state:string;local_available?:boolean;last_error?:string|null;upload_updated_at?:string|null}, now:number){
 const completed=row.local_available===false&&(row.upload_state==='uploaded'||row.last_error?.startsWith('App copy removed by user.'));
 if(!completed)return true;
 const updated=Date.parse(row.upload_updated_at||'');
 return Number.isFinite(updated)&&now-updated<10_000;
}
function priority(row:QueueRow){
 if(row.upload_state==='uploading'||(isQueuedWork(row)&&row.branding_state==='processing'))return 0;
 if(isQueuedWork(row)&&row.branding_state==='complete')return 0.5;
 if(['saved_locally','queued','pending'].includes(row.upload_state))return 1;
 if(row.upload_state==='retrying')return 2;
 return row.upload_state==='failed'?3:4;
}
export function deviceQueueOrder<T extends QueueRow>(rows:T[]):T[]{
 const date=(row:QueueRow)=>Date.parse(row.client_created_at||row.recording_sessions?.created_at||'')||0;
 return [...rows].sort((a,b)=>priority(a)-priority(b)||(priority(a)<3?date(a)-date(b):date(b)-date(a))||a.session_id.localeCompare(b.session_id));
}
