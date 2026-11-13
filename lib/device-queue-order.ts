type QueueRow={session_id:string;upload_state:string;branding_state?:string|null;client_created_at?:string|null;
  upload_queued_at?:string|null;upload_retry_at?:string|null;recording_sessions?:{created_at?:string|null}|null};
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
function priority(row:QueueRow, now:number){
 if(row.upload_state==='uploading')return 0;
 if(isQueuedWork(row) && Date.parse(row.upload_retry_at||'')>now)return 2;
 if(isQueuedWork(row)&&row.branding_state==='processing')return 0.5;
 if(isQueuedWork(row)&&row.branding_state==='complete')return 0.75;
 if(row.upload_state==='retrying' && row.upload_retry_at===undefined)return 2;
 if(isQueuedWork(row))return 1;
 return row.upload_state==='failed'?3:4;
}
export function deviceQueueOrder<T extends QueueRow>(rows:T[], now=Date.now()):T[]{
 const date=(row:QueueRow)=>Date.parse(row.client_created_at||row.recording_sessions?.created_at||'')||0;
 const queued=(row:QueueRow)=>Date.parse(row.upload_queued_at||'')||Infinity;
 return [...rows].sort((a,b)=>{
   const rank=priority(a,now);
   return rank-priority(b,now) ||
     (rank<3 ? (queued(a)-queued(b)||date(a)-date(b)) : date(b)-date(a)) ||
     a.session_id.localeCompare(b.session_id);
 });
}
