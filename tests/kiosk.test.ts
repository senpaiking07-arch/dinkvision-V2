import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { recordingMessage } from "../lib/gmail";
import { provisionLegacyFixtureMemberships } from "./helpers/legacy-memberships";
test("guest capture has no account, scopes session control, and preserves court locks", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
      create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to authenticated,anon;
      alter default privileges in schema public grant all on tables to authenticated,anon;
      alter default privileges in schema public grant usage,select on sequences to authenticated;`);
    for (const file of (await readdir("supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await db.exec(
        (await readFile(`supabase/migrations/${file}`, "utf8")).replace(
          "create extension if not exists pgcrypto;",
          "",
        ),
      );

    const admin = randomUUID(),
      kiosk = randomUUID(),
      other = randomUUID(),
      court = randomUUID(),
      recorder = randomUUID(),
      key = randomUUID();
    await db.query("insert into auth.users(id) values($1)", [admin]);
    await db.query("update public.profiles set role='admin' where id=$1", [
      admin,
    ]);
    await provisionLegacyFixtureMemberships(db);
    await db.query(
      "insert into public.kiosk_devices(id,token_hash,created_by) values($1,'hash1',$3),($2,'hash2',$3)",
      [kiosk, other, admin],
    );
    await db.query("insert into public.courts(id,name) values($1,'Court')", [
      court,
    ]);
    await db.query(
      "insert into public.recorders(id,name,paired_at,last_seen_at,ffmpeg_available,agent_version) values($1,'Recorder',now(),now(),true,'0.4.0')",
      [recorder],
    );
    await db.query(
      "insert into public.cameras(name,recorder_id,court_id,source_type,device_reference,is_primary,enabled,health,last_health_check_at) values('Camera',$1,$2,'usb','usb-test',true,true,'online',now())",
      [recorder, court],
    );
    const start = async (who = kiosk, k = key) =>
      (
        await db.query<{ id: string }>(
          "select public.start_guest_capture($1,'guest@outlook.com',$2,$3) id",
          [who, court, k],
        )
      ).rows[0].id;
    const id = await start();
    assert.equal(await start(), id);
    const session = (
      await db.query<any>(
        "select * from public.recording_sessions where id=$1",
        [id],
      )
    ).rows[0];
    assert.equal(session.player_id, null);
    assert.equal(session.kiosk_id, kiosk);
    assert.equal(session.configuration_snapshot.sharing_mode, "private");
    assert.equal(
      (await db.query<any>("select count(*)::int n from auth.users")).rows[0].n,
      1,
    );
    await assert.rejects(() => start(other, randomUUID()), /already recording/);
    await assert.rejects(() => start(kiosk, randomUUID()), /active recording/);
    const action = async (who: string, reset: boolean) =>
      (
        await db.query<any>("select public.kiosk_session_action($1,$2,$3) ok", [
          who,
          id,
          reset,
        ])
      ).rows[0].ok;
    assert.equal(await action(other, false), false);
    assert.equal(await action(kiosk, true), false);
    assert.equal(await action(kiosk, false), true);
    await db.exec("set role anon");
    await assert.rejects(() => start(), /permission denied/);
    await assert.rejects(
      () => db.query("select * from public.kiosk_devices"),
      /permission denied/,
    );
    assert.equal(
      (await db.query("select * from public.recording_sessions")).rows.length,
      0,
    );
    await db.exec(
      "reset role; update public.recording_sessions set status='local_ready';",
    );
    assert.equal(await action(kiosk, true), true);
    assert.equal(
      (
        await db.query<any>(
          "select current_session_id from public.kiosk_devices where id=$1",
          [kiosk],
        )
      ).rows[0].current_session_id,
      null,
    );
    await db.query("update public.kiosk_devices set active=false where id=$1", [
      kiosk,
    ]);
    await assert.rejects(() => start(kiosk, randomUUID()), /not enabled/);
  } finally {
    await db.close();
  }
});
