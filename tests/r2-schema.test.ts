import test from "node:test";
import assert from "node:assert/strict";
import { readFile,readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { DEFAULT_TENANT_ID } from "../lib/tenant-scope";
import { migrationSQL } from "../scripts/migration-role-compat.mjs";
import { R2_MAX_BYTES, uploadPartSize } from "../lib/r2-protocol";
import { settingsInput } from "../lib/validation";

test("R2 completion is atomic, tenant-bound, idempotent and cannot undo cancellation",async()=>{
 const db=new PGlite();
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
   create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema public,auth to authenticated,anon,service_role;
   alter default privileges in schema public grant all on tables to authenticated,anon;
   alter default privileges in schema public grant usage,select on sequences to authenticated;`);
  for(const name of (await readdir("supabase/migrations")).filter(n=>n.endsWith(".sql")).sort())
   await db.exec(migrationSQL((await readFile(`supabase/migrations/${name}`,"utf8")).replace("create extension if not exists pgcrypto;","")));
  const admin=randomUUID(),court=randomUUID(),kiosk=randomUUID(),device=randomUUID();
  await db.query("insert into auth.users(id) values($1)",[admin]);
  await db.query("insert into courts(id,name) values($1,'R2 test court')",[court]);
  await db.query("insert into kiosk_devices(id,token_hash,created_by) values($1,'r2-fixture',$2)",[kiosk,admin]);
  await db.query("insert into browser_devices(id,name,court_id,kiosk_id) values($1,'R2 test device',$2,$3)",[device,court,kiosk]);
  const largeSession=randomUUID();
  await db.query(`insert into recording_sessions(id,kiosk_id,court_id,idempotency_key,status,configuration_snapshot,recipient_email)
   values($1,$2,$3,gen_random_uuid(),'uploading','{}','fixture@example.invalid')`,[largeSession,kiosk,court]);
  await db.query("insert into browser_recordings(session_id,device_id) values($1,$2)",[largeSession,device]);
  const register=(bytes:number)=>db.query<{ok:boolean}>(
   "select browser_event($1,$2,'saved',$3,'video/mp4') ok",[kiosk,largeSession,bytes]);
  await assert.rejects(()=>register(R2_MAX_BYTES+1),/Invalid recording/);
  assert.equal((await register(R2_MAX_BYTES)).rows[0].ok,true);
  assert.equal((await register(R2_MAX_BYTES)).rows[0].ok,true);
  await db.query(`insert into r2_upload_attempts(id,session_id,device_id,bucket,object_key,bytes,mime_type,state,part_size)
   values(gen_random_uuid(),$1,$2,'test-bucket','tenants/large.mp4',$3,'video/mp4','creating',$4)`,
   [largeSession,device,R2_MAX_BYTES,uploadPartSize(R2_MAX_BYTES,undefined)]);
  await db.query("update browser_recordings set upload_state='uploading',upload_updated_at=now()-interval '4 minutes' where session_id=$1",[largeSession]);
  await db.query("select expire_browser_uploads($1)",[device]);
  assert.equal((await db.query<{upload_state:string}>("select upload_state from browser_recordings where session_id=$1",[largeSession])).rows[0].upload_state,"uploading");
  await db.query("update browser_recordings set upload_updated_at=now()-interval '16 minutes' where session_id=$1",[largeSession]);
  await db.query("select expire_browser_uploads($1)",[device]);
  assert.equal((await db.query<{upload_state:string}>("select upload_state from browser_recordings where session_id=$1",[largeSession])).rows[0].upload_state,"failed");
  async function recording() {
   const session=randomUUID(),file=randomUUID(),attempt=randomUUID(),lease=randomUUID();
   await db.query(`insert into recording_sessions(id,kiosk_id,court_id,idempotency_key,status,configuration_snapshot,recipient_email)
    values($1,$2,$3,gen_random_uuid(),'uploading','{"retention_seconds":3600}','fixture@example.invalid')`,[session,kiosk,court]);
   await db.query("insert into recording_files(id,session_id,status,bytes) values($1,$2,'local_ready',1024)",[file,session]);
   await db.query(`insert into browser_recordings(session_id,device_id,file_id,bytes,mime_type,upload_state,lease_token,lease_until)
    values($1,$2,$3,1024,'video/mp4','uploading',$4,now()+interval '2 minutes')`,[session,device,file,lease]);
   await db.query(`insert into r2_upload_attempts(id,session_id,device_id,bucket,object_key,upload_id,bytes,mime_type,state)
    values($1,$2,$3,'test-bucket',$4,'remote-id',1024,'video/mp4','uploading')`,[attempt,session,device,`tenants/${DEFAULT_TENANT_ID}/${attempt}.mp4`]);
   return {session,file,attempt,lease};
  }
  async function finish(r:Awaited<ReturnType<typeof recording>>,tenant=DEFAULT_TENANT_ID,selectedDevice=device,bytes=1024) {
   await db.exec("begin;set local role service_role;set local request.jwt.claim.role='service_role';");
   try {
    await db.query("select set_config('request.headers',$1,true)",[JSON.stringify({"x-dinkvision-tenant-id":tenant})]);
    return (await db.query<{ok:boolean}>("select finish_r2_upload($1,$2,$3,$4,$5,$6) ok",[r.session,selectedDevice,r.attempt,r.lease,'"verified-etag"',bytes])).rows[0].ok;
   } finally {await db.exec("commit");}
  }
  const one=await recording();
  assert.equal(await finish(one,DEFAULT_TENANT_ID,randomUUID()),false);
  assert.equal(await finish(one,DEFAULT_TENANT_ID,device,1023),false);
  const foreign=randomUUID();
  await db.query("insert into tenants(id,name,slug) values($1,'Other','other-r2')",[foreign]);
  assert.equal(await finish(one,foreign),false);
  assert.equal(await finish(one),true);
  assert.equal(await finish(one),true);
  assert.equal((await db.query<{n:number}>("select count(*)::int n from email_jobs where file_id=$1",[one.file])).rows[0].n,1);
  const file=(await db.query<any>("select storage_provider,storage_key,drive_file_id,status,expires_at::text as expires_at from recording_files where id=$1",[one.file])).rows[0];
  assert.equal(file.storage_provider,"r2");assert.equal(file.drive_file_id,null);assert.equal(file.status,"ready");
  const pendingRetention = await recording();
  const saved = settingsInput({ duration_minutes: 15, retention_days: 7, venue_time_zone: "Asia/Manila" });
  await db.query("update venue_settings set retention_seconds=$1 where id=true and tenant_id=$2", [saved.retention_seconds, DEFAULT_TENANT_ID]);
  const loaded = await db.query<{ retention_seconds: number }>(
   "select retention_seconds from venue_settings where id=true and tenant_id=$1", [DEFAULT_TENANT_ID]);
  assert.equal(loaded.rows[0].retention_seconds, 604800);
  const existingExpiry = await db.query<{ expires_at: string }>(
   "select expires_at::text as expires_at from recording_files where id=$1", [one.file]);
  assert.equal(existingExpiry.rows[0].expires_at, file.expires_at);
  assert.equal(await finish(pendingRetention), true);
  const retained = await db.query<{ snapshot: number; lifetime: number }>(
   `select (s.configuration_snapshot->>'retention_seconds')::int as snapshot,
     extract(epoch from f.expires_at - f.uploaded_at)::int as lifetime
     from recording_sessions s join recording_files f on f.session_id=s.id where f.id=$1`, [pendingRetention.file]);
  assert.deepEqual(retained.rows[0], { snapshot: 3600, lifetime: 3600 });
  await db.query("update browser_recordings set upload_state='failed',last_error='late failure' where session_id=$1",[one.session]);
  assert.equal((await db.query<any>("select upload_state from browser_recordings where session_id=$1",[one.session])).rows[0].upload_state,"uploaded");
  const two=await recording();
  await db.query("select cancel_browser_upload($1,$2)",[two.session,device]);
  assert.equal(await finish(two),false);
  assert.equal((await db.query<any>("select status from recording_files where id=$1",[two.file])).rows[0].status,"local_ready");
  const interrupted=await recording();
  await db.query("update recording_sessions set capture_interruption_code='camera_disconnected',capture_inspection_required=true where id=$1",[interrupted.session]);
  assert.equal(await finish(interrupted),false);
  async function cleanup(tenant=DEFAULT_TENANT_ID,lease=one.lease) {
   await db.exec("begin;set local role service_role;set local request.jwt.claim.role='service_role';");
   try {
    await db.query("select set_config('request.headers',$1,true)",[JSON.stringify({"x-dinkvision-tenant-id":tenant})]);
    return (await db.query<{ok:boolean}>("select finish_r2_cleanup($1,$2) ok",[one.file,lease])).rows[0].ok;
   } finally {await db.exec("commit");}
  }
  assert.equal(await cleanup(),false); // ready and not expired
  await db.query("update browser_recordings set lease_token=$2,lease_until=now()+interval '90 seconds' where file_id=$1",[one.file,one.lease]);
  await db.query("update recording_files set status='deleting',expires_at=now()-interval '1 second' where id=$1",[one.file]);
  assert.equal(await cleanup(foreign),false);
  assert.equal(await cleanup(DEFAULT_TENANT_ID,randomUUID()),false);
  assert.equal(await cleanup(),true);
  assert.equal(await cleanup(),true);
  assert.equal((await db.query<any>("select status from recording_sessions where id=$1",[one.session])).rows[0].status,"deleted");
  assert.equal((await db.query<any>("select count(*)::int n from audit_events where session_id=$1 and action='retention.r2_cloud_deleted'",[one.session])).rows[0].n,1);
  await db.exec("begin;set local role authenticated;");
  await assert.rejects(()=>db.query("select * from r2_upload_attempts"),/permission denied/);
  await db.exec("rollback;");
  assert.equal((await db.query<any>("select has_function_privilege('anon','finish_r2_upload(uuid,uuid,uuid,uuid,text,bigint)','EXECUTE') ok")).rows[0].ok,false);
  assert.equal((await db.query<any>("select has_schema_privilege('dinkvision_executor','public','CREATE') ok")).rows[0].ok,false);
 } finally {await db.close();}
});
