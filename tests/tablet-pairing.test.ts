import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

test("tablet pairing requires venue approval and private claim, survives reply loss, and keeps registration one-to-one", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
      create table auth.users(id uuid primary key,email text unique,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to authenticated,anon,service_role;
      alter default privileges in schema public grant all on tables to authenticated,anon;
      alter default privileges in schema public grant usage,select on sequences to authenticated;`);
    for (const file of (await readdir("supabase/migrations")).filter(file => file.endsWith(".sql")).sort())
      await db.exec((await readFile(`supabase/migrations/${file}`,"utf8")).replace("create extension if not exists pgcrypto;",""));

    const admin = randomUUID(), other = randomUUID();
    const court = randomUUID(), device = randomUUID(), request = randomUUID(), competing = randomUUID(), expired = randomUUID();
    await db.query("insert into auth.users(id,email) values($1,'admin@example.invalid'),($2,'other@example.invalid')", [admin,other]);
    const tenant = (await db.query<{id:string}>("select public.register_tenant($1,'Pair venue','pair-venue') id", [admin])).rows[0].id;
    const otherTenant = (await db.query<{id:string}>("select public.register_tenant($1,'Other venue','other-venue') id", [other])).rows[0].id;
    await db.query("insert into courts(id,tenant_id,name,active) values($1,$2,'Court 1',true)", [court,tenant]);
    await db.query("insert into browser_devices(id,tenant_id,court_id,name,enabled) values($1,$2,$3,'Fixture',true)", [device,tenant,court]);
    const scope = async (id: string) => {
      await db.query("select set_config('request.headers',$1,false)", [JSON.stringify({"x-dinkvision-tenant-id":id})]);
    };
    async function value(sql: string, args: unknown[]) {
      return (await db.query<{value:unknown}>(`select ${sql} as value`, args)).rows[0].value;
    }
    const create = (id: string, claim: string, pin: string) => value("public.create_tablet_pairing($1,$2,$3,null)", [id,claim,pin]);
    const approve = (id: string | null, pin: string, actor: string, venue: string) =>
      value("public.decide_tablet_pairing($1,$2,$3,$4,$5,$6,false,false)", [id,pin,device,court,actor,venue]);
    const claim = (id: string, proof: string, token: string) =>
      value("public.claim_tablet_pairing($1,$2,$3,$4)", [id,proof,token,"fixture-setup"]);

    await db.exec("set role anon");
    await assert.rejects(() => create(request,"private-proof","012345"), /permission denied/);
    await assert.rejects(() => db.query("select * from public.tablet_pairing_requests"), /permission denied/);
    await db.exec("reset role; set role service_role");
    await scope(tenant);
    const first = await create(request,"private-proof","012345");
    assert.equal((first as {pin:string}).pin, "012345");
    assert.deepEqual(await create(request,"private-proof","333333"), first);
    assert.equal(await create(request,"other-proof","333333"), null);
    await assert.rejects(() => create(competing,"competing-proof","012345"), /duplicate key/);
    await create(competing,"competing-proof","012346");
    assert.equal(await claim(request,"private-proof","fixture-token"), "pending");
    assert.equal(await claim(request,"wrong-proof","fixture-token"), "unavailable");
    assert.equal(await approve(request,"012345",other,tenant), "forbidden");
    await scope(otherTenant);
    assert.equal(await approve(request,"012345",other,otherTenant), "assignment");
    await scope(tenant);
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal(await approve(null,"000000",admin,tenant), "unavailable");
    }
    assert.equal(await approve(request,"012345",admin,tenant), "limited");
    await db.query("update public.tablet_pairing_limits set expires_at=now()-interval '1 second'");
    assert.equal(await approve(request,"012345",admin,tenant), "approved");
    assert.equal(await approve(request,"012345",admin,tenant), "approved");
    assert.equal(await approve(competing,"012346",admin,tenant), "approved");
    assert.equal(await claim(request,"wrong-proof","fixture-token"), "unavailable");
    assert.equal(await claim(request,"private-proof","fixture-token"), "enrolled");
    assert.equal(await claim(competing,"competing-proof","competing-token"), "assignment");
    assert.equal(await claim(request,"private-proof","fixture-token"), "enrolled");
    await db.query("update public.tablet_pairing_requests set expires_at=now()-interval '1 second' where id=$1",[request]);
    assert.equal(await claim(request,"private-proof","fixture-token"), "enrolled");
    assert.equal(await claim(request,"private-proof","different-token"), "unavailable");
    await create(expired,"expired-proof","012345");
    await db.query("update public.tablet_pairing_requests set expires_at=now()-interval '1 second' where id=$1",[expired]);
    assert.equal(await claim(expired,"expired-proof","expired-token"), "expired");
    const rows = (await db.query("select id from kiosk_devices where tenant_id=$1 and active",[tenant])).rows;
    assert.equal(rows.length, 1);
    const enrollmentHashes = async () => (await db.query(
      "select enrollment_hash, consumed_enrollment_hash from browser_devices where id=$1", [device],
    )).rows[0];
    await db.query("update browser_devices set enrollment_hash='replacement-invitation', enrollment_expires_at=now()+interval '10 minutes' where id=$1", [device]);
    assert.deepEqual(await enrollmentHashes(), {
      enrollment_hash: "replacement-invitation", consumed_enrollment_hash: "private-proof",
    });
    await db.query("update browser_devices set enabled=false,enrollment_hash=null,setup_hash=null where id=$1", [device]);
    assert.deepEqual(await enrollmentHashes(), {
      enrollment_hash: null, consumed_enrollment_hash: "private-proof",
    });
    await db.query("update browser_devices set enabled=true,enrollment_hash='new-invitation',enrollment_expires_at=now()+interval '10 minutes' where id=$1", [device]);
    await value("public.enroll_browser($1,$2,$3,$4,null)", ["new-invitation", "new-token", "new-setup", admin]);
    assert.deepEqual(await enrollmentHashes(), {
      enrollment_hash: null, consumed_enrollment_hash: "new-invitation",
    });
  } finally {
    await db.close();
  }
});

test("scanner fallback preserves the same pairing request and refuses a foreign destination", async () => {
  const { pairingBrowserLinks } = await import("../lib/tablet-enrollment");
  const id = "11111111-1111-4111-8111-111111111111";
  const path = `/admin/pair-device?request=${id}`;
  const origin = "https://example.invalid";
  const ios = pairingBrowserLinks(path, origin, false);
  const android = pairingBrowserLinks(path, origin, true);
  assert.equal(ios.external, origin + path);
  assert.match(android.external, /^intent:\/\/example\.invalid\/admin\/pair-device\?request=/);
  assert.ok(android.external.includes(encodeURIComponent(ios.page)));
  assert.equal(pairingBrowserLinks("https://other.invalid/evil", origin, true).page, origin + "/admin/pair-device");
  assert.equal(pairingBrowserLinks(path, "http://localhost:3000", true).external, "http://localhost:3000" + path);
});
