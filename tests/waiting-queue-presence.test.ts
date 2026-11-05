import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';

test('waiting presence preserves FIFO/retries/bytes, but stale transfers and offline waiters still expire', async()=>{
 const db=new PGlite();
 try {
  await db.exec(`create role dinkvision_executor;create role anon;create role authenticated;create role service_role;
   create table recording_sessions(id uuid primary key,status text);
   create table browser_recordings(session_id uuid primary key,device_id uuid,upload_state text,lease_until timestamptz,lease_token uuid,upload_updated_at timestamptz,upload_queued_at timestamptz,last_seen_at timestamptz,last_error text,safe_error text,retry_count int,uploaded_bytes bigint,local_available boolean);
   grant select,update on browser_recordings to dinkvision_executor;grant select on recording_sessions to dinkvision_executor;`);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261103130000_waiting_recorder_presence.sql',import.meta.url),'utf8'));
  const states=['pending','queued','retrying','uploading','retrying','uploading','retrying'];
  for(let n=0;n<states.length;n++) {
   const id=`00000000-0000-0000-0000-${String(n+1).padStart(12,'0')}`;
   await db.query(`insert into recording_sessions values($1,'uploading')`,[id]);
   await db.query(`insert into browser_recordings values($1,'10000000-0000-0000-0000-000000000001',$2,${n===5?"now()+interval '1 minute'":"null"},null,now()-interval '10 minutes',now()-interval '1 hour',${n===4?"now()-interval '4 minutes'":n===6?'null':'now()'},null,null,3,4194304,true)`,[id,states[n]]);
  }
  await db.exec('select expire_browser_uploads(null)');
  const rows=(await db.query<any>('select * from browser_recordings order by session_id')).rows;
  assert.deepEqual(rows.map(x=>x.upload_state),['pending','queued','retrying','failed','failed','uploading','failed']);
  assert.ok(rows.every(x=>x.retry_count===3&&Number(x.uploaded_bytes)===4194304&&x.local_available));
  for(const row of rows.slice(0,3))assert.ok(new Date(row.upload_queued_at).getTime()<Date.now()-50*60000);
 } finally {await db.close();}
});
