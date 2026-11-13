import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { TENANT_HEADER } from "../lib/tenant-scope";

test("diagnostic history is immutable, idempotent and isolated between tenant admins",async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
      create table auth.users(id uuid primary key,email text unique,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to authenticated,anon,service_role;
      alter default privileges in schema public grant all on tables to authenticated,anon;
      alter default privileges in schema public grant usage,select on sequences to authenticated;`);
    for(const file of (await readdir("supabase/migrations")).filter(n=>n.endsWith(".sql")).sort())
      await db.exec((await readFile("supabase/migrations/"+file,"utf8")).replace("create extension if not exists pgcrypto;",""));
    const a=randomUUID(),b=randomUUID();
    await db.query("insert into auth.users(id,email) values($1,'a@example.invalid'),($2,'b@example.invalid')",[a,b]);
    const ta=(await db.query<{id:string}>("select public.register_tenant($1,'Diagnostic A','diagnostic-a') id",[a])).rows[0].id;
    const tb=(await db.query<{id:string}>("select public.register_tenant($1,'Diagnostic B','diagnostic-b') id",[b])).rows[0].id;
    const device=randomUUID(),event=randomUUID(),attempt=randomUUID();
    const insert=`insert into public.recorder_diagnostics(tenant_id,device_id,event_id,attempt_id,operation,stage,result,code,
      elapsed_ms,duration_ms,occurred_at,queue_count,bytes,retry_count,version_code)
      values($1,$2,$3,$4,'capture','reserve','failed','timeout',30000,30000,now(),3,0,0,49)
      on conflict (tenant_id,device_id,event_id) do nothing`;
    await db.exec("set role service_role");
    await db.query(insert,[ta,device,event,attempt]);await db.query(insert,[ta,device,event,attempt]);
    await assert.rejects(()=>db.query("update public.recorder_diagnostics set code='none'"),/permission denied/);
    const action = randomUUID();
    await db.query(`insert into public.recorder_diagnostics
      (tenant_id,device_id,event_id,attempt_id,operation,stage,result,code,elapsed_ms,duration_ms,
      occurred_at,queue_count,bytes,retry_count,version_code,action_source,repeated_actions)
      values($1,$2,$3,$4,'capture','stop_repeated','ok','none',100,0,now(),3,0,0,52,'notification',2)`,
      [ta,device,action,attempt]);
    await db.exec("reset role");
    await db.query(insert,[tb,device,event,attempt]);
    for(const [tid,user] of [[ta,a],[tb,b]]) {
      await db.exec("reset role");
      await db.query("select set_config('request.headers',$1,false),set_config('request.jwt.claim.sub',$2,false)",
        [JSON.stringify({[TENANT_HEADER]:tid}),user]);
      await db.exec("set role authenticated");
      const rows=(await db.query<{tenant_id:string}>("select * from public.recorder_diagnostics")).rows;
      assert.equal(rows.length,tid===ta?2:1);assert.ok(rows.every(row=>row.tenant_id===tid));
      await assert.rejects(()=>db.query(insert,[tid,device,randomUUID(),attempt]),/permission denied/);
    }
    await db.exec("reset role;set role anon");
    await assert.rejects(()=>db.query("select * from public.recorder_diagnostics"),/permission denied/);
  }finally{await db.close();}
});
