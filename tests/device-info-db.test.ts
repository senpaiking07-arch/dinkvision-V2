import test from "node:test";
import assert from "node:assert/strict";
import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";

test("optional device inventory migration preserves existing rows and rejects invalid documents", async () => {
  const db = new PGlite();
  try {
    await db.exec("create table browser_devices(id int primary key);insert into browser_devices values(1)");
    const migration = readFileSync(new URL("../supabase/migrations/20261101192538_recorder_device_info.sql", import.meta.url), "utf8");
    await db.exec(migration);
    await db.exec(migration);
    assert.equal((await db.query<any>("select device_info from browser_devices where id=1")).rows[0].device_info, null);
    await db.query("update browser_devices set device_info=$1::jsonb where id=1", [JSON.stringify({model:"SM-A226B"})]);
    for (const document of [[], "invalid", {model:"x".repeat(4100)}])
      await assert.rejects(db.query("update browser_devices set device_info=$1::jsonb where id=1", [JSON.stringify(document)]));
    assert.deepEqual((await db.query<any>("select device_info from browser_devices where id=1")).rows[0].device_info, {model:"SM-A226B"});
  } finally {await db.close();}
});

test("device copy receipts are additive and preserve existing recording rows",async()=>{
  const db=new PGlite();try{
    await db.exec("create table browser_recordings(id int primary key);insert into browser_recordings values(1)");
    const sql=readFileSync(new URL('../supabase/migrations/20261102000916_device_copy_receipts.sql',import.meta.url),'utf8');
    await db.exec(sql);await db.exec(sql);
    assert.equal((await db.query<any>('select device_copy_saved_at from browser_recordings')).rows[0].device_copy_saved_at,null);
    await assert.rejects(db.exec('update browser_recordings set device_copy_bytes=-1'));
    await db.exec('update browser_recordings set device_copy_saved_at=now(),device_copy_bytes=2048');
    assert.equal((await db.query<any>('select device_copy_bytes from browser_recordings')).rows[0].device_copy_bytes,2048);
  }finally{await db.close();}
});

test("logo progress is optional for older clients and limited to a valid percentage",async()=>{
 const db=new PGlite();try{
  await db.exec('create table browser_recordings(id int primary key);insert into browser_recordings values(1)');
  const sql=readFileSync(new URL('../supabase/migrations/20261102005631_branding_progress.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
  assert.equal((await db.query<any>('select branding_progress from browser_recordings')).rows[0].branding_progress,null);
  for(const n of [-1,101])await assert.rejects(db.exec(`update browser_recordings set branding_progress=${n}`));
  await db.exec('update browser_recordings set branding_progress=52');
  assert.equal((await db.query<any>('select branding_progress from browser_recordings')).rows[0].branding_progress,52);
 }finally{await db.close();}
});
