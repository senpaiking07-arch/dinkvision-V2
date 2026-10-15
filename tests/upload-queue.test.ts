import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

test("cameras on the same court share one FIFO upload queue", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
      create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to authenticated,anon;
      alter default privileges in schema public grant all on tables to authenticated,anon;
      alter default privileges in schema public grant usage,select on sequences to authenticated;`);
    for (const file of (await readdir("supabase/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await db.exec(
        (await readFile(`supabase/migrations/${file}`, "utf8")).replace(
          "create extension if not exists pgcrypto;",
          "",
        ),
      );

    const admin = randomUUID();
    const courts = [randomUUID(), randomUUID()];
    const kiosks = [randomUUID(), randomUUID()];
    const devices = [randomUUID(), randomUUID()];
    const sessions = [randomUUID(), randomUUID(), randomUUID()];
    await db.query("insert into auth.users(id) values($1)", [admin]);
    await db.query(
      "insert into courts(id,name) values($1,'Court 1'),($2,'Court 2')",
      courts,
    );
    await db.query(
      "insert into kiosk_devices(id,token_hash,created_by) values($1,'queue-token-1',$3),($2,'queue-token-2',$3)",
      [kiosks[0], kiosks[1], admin],
    );
    await db.query(
      "insert into browser_devices(id,name,court_id,kiosk_id) values($1,'Tablet 1',$3,$4),($2,'Tablet 2',$3,$5)",
      [devices[0], devices[1], courts[0], kiosks[0], kiosks[1]],
    );
    await db.query(
      `insert into recording_sessions(id,kiosk_id,court_id,idempotency_key,status,configuration_snapshot,recipient_email,stopped_at,created_at)
       values($1,$4,$6,gen_random_uuid(),'uploading','{}','one@gmail.com',now()-interval '2 minutes',now()-interval '5 minutes'),
             ($2,$5,$6,gen_random_uuid(),'uploading','{}','two@gmail.com',now()-interval '1 minute',now()-interval '4 minutes'),
             ($3,$4,$6,gen_random_uuid(),'uploading','{}','three@gmail.com',now()-interval '30 seconds',now()-interval '3 minutes')`,
      [sessions[0], sessions[1], sessions[2], kiosks[0], kiosks[1], courts[0]],
    );
    const files = await db.query<{ id: string }>(
      `insert into recording_files(session_id,status,bytes)
       values($1,'local_ready',1000),($2,'local_ready',1000),($3,'local_ready',1000) returning id`,
      sessions,
    );
    await db.query(
      `insert into browser_recordings(session_id,device_id,file_id,mime_type,bytes,upload_state,upload_queued_at,upload_updated_at)
       values($1,$4,$6,'video/mp4',1000,'pending',now()-interval '2 minutes',now()),
             ($2,$5,$7,'video/mp4',1000,'pending',now()-interval '1 minute',now()),
             ($3,$4,$8,'video/mp4',1000,'pending',now()-interval '30 seconds',now())`,
      [
        sessions[0],
        sessions[1],
        sessions[2],
        devices[0],
        devices[1],
        files.rows[0].id,
        files.rows[1].id,
        files.rows[2].id,
      ],
    );

    const turn = async (index: number, claim = true) =>
      (
        await db.query<any>(
          "select * from browser_upload_turn($1,$2,$3)",
          [sessions[index], devices[index === 1 ? 1 : 0], claim],
        )
      ).rows[0];
    const report = async (
      index: number,
      state: "uploading" | "failed" | "complete",
      bytes: number,
    ) =>
      (
        await db.query<{ ok: boolean }>(
          "select report_browser_upload($1,$2,$3,$4) ok",
          [sessions[index], devices[index === 1 ? 1 : 0], state, bytes],
        )
      ).rows[0].ok;

    // Every camera on the court shares one FIFO queue, ordered by queue time.
    const first = await turn(0);
    assert.equal(first.allowed, true);
    assert.equal(first.queue_position, 1);
    assert.equal(first.queue_total, 3);
    assert.equal(first.active_device_name, "Tablet 1");

    const second = await turn(1);
    assert.equal(second.allowed, false, "cameras on the same court share one queue");
    assert.equal(second.queue_position, 2);
    assert.equal(second.queue_total, 3);
    assert.equal(second.active_device_name, "Tablet 1");

    const third = await turn(2);
    assert.equal(third.allowed, false);
    assert.equal(third.queue_position, 3);
    assert.equal(third.queue_total, 3);
    assert.equal(third.active_device_name, "Tablet 1");

    assert.equal(await report(0, "uploading", 400), true);
    assert.equal((await turn(2, false)).active_percent, 40);

    // A camera on another court uploads without waiting for this court.
    const otherCourt = courts[1];
    const otherKiosk = randomUUID();
    const otherDevice = randomUUID();
    const otherSession = randomUUID();
    await db.query(
      "insert into kiosk_devices(id,token_hash,created_by) values($1,'queue-token-3',$2)",
      [otherKiosk, admin],
    );
    await db.query(
      "insert into browser_devices(id,name,court_id,kiosk_id) values($1,'Tablet 3',$2,$3)",
      [otherDevice, otherCourt, otherKiosk],
    );
    await db.query(
      `insert into recording_sessions(id,kiosk_id,court_id,idempotency_key,status,configuration_snapshot,recipient_email,stopped_at)
       values($1,$2,$3,gen_random_uuid(),'uploading','{}','other@gmail.com',now())`,
      [otherSession, otherKiosk, otherCourt],
    );
    const otherFile = await db.query<{ id: string }>(
      "insert into recording_files(session_id,status,bytes) values($1,'local_ready',1000) returning id",
      [otherSession],
    );
    await db.query(
      `insert into browser_recordings(session_id,device_id,file_id,mime_type,bytes,upload_state,upload_queued_at,upload_updated_at)
       values($1,$2,$3,'video/mp4',1000,'pending',now(),now())`,
      [otherSession, otherDevice, otherFile.rows[0].id],
    );
    const independent = (
      await db.query<any>("select * from browser_upload_turn($1,$2,true)", [
        otherSession,
        otherDevice,
      ])
    ).rows[0];
    assert.equal(independent.allowed, true, "a different court uploads independently");
    assert.equal(independent.queue_position, 1);
    assert.equal(independent.queue_total, 1);
    assert.equal(independent.active_device_name, "Tablet 3");

    // When the court head fails, the next camera on that court takes over.
    assert.equal(await report(0, "failed", 400), true);
    const next = await turn(1);
    assert.equal(next.allowed, true, "a failed item does not block later videos");
    assert.equal(next.queue_position, 1);
    assert.equal(next.queue_total, 2);
    assert.equal(next.active_device_name, "Tablet 2");
    assert.equal(next.blocked_by_failure, false);

    assert.equal(await report(1, "complete", 1000), true);
    await db.query("update recording_sessions set status='ready' where id=$1", [
      sessions[1],
    ]);
    const last = await turn(2);
    assert.equal(last.allowed, true);
    assert.equal(last.queue_position, 1);
    assert.equal(last.queue_total, 1);
    assert.equal(last.active_device_name, "Tablet 1");
    assert.equal(await report(2, "complete", 1000), true);
    await db.query("update recording_sessions set status='ready' where id=$1", [
      sessions[2],
    ]);

    await db.query(
      "update kiosk_devices set current_session_id=$1 where id=$2",
      [sessions[0], kiosks[0]],
    );

    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select cancel_browser_upload($1,$2) ok",
          [sessions[0], devices[0]],
        )
      ).rows[0].ok,
      true,
    );
    const cancelled = await turn(0, false);
    assert.equal(cancelled.upload_state, "cancelled");
    assert.equal(cancelled.queue_position, 0);
    assert.deepEqual(
      (
        await db.query<{ status: string; failure_stage: string; current_session_id: string | null }>(
          `select s.status,s.failure_stage,k.current_session_id
           from recording_sessions s join kiosk_devices k on k.id=s.kiosk_id
           where s.id=$1`,
          [sessions[0]],
        )
      ).rows[0],
      {
        status: "failed",
        failure_stage: "upload_cancelled",
        current_session_id: null,
      },
      "cancelling an upload releases the tablet recording lock",
    );

    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select queue_browser_upload($1,$2) ok",
          [sessions[0], devices[0]],
        )
      ).rows[0].ok,
      true,
      "a cancelled local video can reopen its queue from the recording device",
    );

    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select retry_browser_upload($1,$2) ok",
          [sessions[0], devices[0]],
        )
      ).rows[0].ok,
      true,
      "retry is safe when local recovery already reopened the server queue",
    );
    const requeued = await turn(0, false);
    assert.equal(requeued.allowed, true);
    assert.equal(requeued.upload_state, "retrying");
    assert.equal(requeued.queue_position, 1);
    assert.equal(requeued.queue_total, 1);
    assert.equal(requeued.active_device_name, "Tablet 1");

    const retried = await turn(0);
    assert.equal(retried.allowed, true);
    assert.equal(retried.queue_position, 1);
    assert.equal(retried.active_device_name, "Tablet 1");

    await db.query(
      "update recording_sessions set started_at=now()-interval '30 seconds',stopped_at=now() where id=$1",
      [sessions[0]],
    );
    assert.equal(
      (
        await db.query<{ held: boolean }>(
          "select hold_short_browser_recording($1,$2,$3) held",
          [sessions[0], devices[0], 60000],
        )
      ).rows[0].held,
      false,
      "an exact one-minute recording remains uploadable",
    );
    assert.equal(
      (
        await db.query<{ held: boolean }>(
          "select hold_short_browser_recording($1,$2,$3) held",
          [sessions[0], devices[0], 30000],
        )
      ).rows[0].held,
      true,
    );
    const localOnly = await db.query<{
      status: string;
      failure_stage: string;
      upload_state: string;
    }>(
      `select s.status,s.failure_stage,b.upload_state
       from recording_sessions s join browser_recordings b on b.session_id=s.id
       where s.id=$1`,
      [sessions[0]],
    );
    assert.deepEqual(localOnly.rows[0], {
      status: "failed",
      failure_stage: "short_recording",
      upload_state: "local_only",
    });

    const legacyCourt = randomUUID(),
      legacyKiosk = randomUUID(),
      legacyDevice = randomUUID(),
      legacySession = randomUUID();
    await db.query("insert into courts(id,name) values($1,'Legacy Court')", [
      legacyCourt,
    ]);
    await db.query(
      "insert into kiosk_devices(id,token_hash,created_by) values($1,'legacy-token',$2)",
      [legacyKiosk, admin],
    );
    await db.query(
      "insert into browser_devices(id,name,court_id,kiosk_id) values($1,'Legacy Tablet',$2,$3)",
      [legacyDevice, legacyCourt, legacyKiosk],
    );
    await db.query(
      `insert into recording_sessions(id,kiosk_id,court_id,idempotency_key,status,configuration_snapshot,recipient_email,stopped_at)
       values($1,$2,$3,gen_random_uuid(),'uploading','{}','legacy@gmail.com',now())`,
      [legacySession, legacyKiosk, legacyCourt],
    );
    const legacyFile = await db.query<{ id: string }>(
      "insert into recording_files(session_id,status,bytes) values($1,'local_ready',1000) returning id",
      [legacySession],
    );
    await db.query(
      `insert into browser_recordings(session_id,device_id,file_id,mime_type,bytes,upload_state,upload_queued_at)
       values($1,$2,$3,'video/webm',1000,'queued',now())`,
      [legacySession, legacyDevice, legacyFile.rows[0].id],
    );
    assert.equal(
      (
        await db.query<{ held: boolean }>(
          "select hold_unsupported_browser_recording($1,$2) held",
          [legacySession, legacyDevice],
        )
      ).rows[0].held,
      true,
    );
    const legacyLocal = await db.query<{
      status: string;
      failure_stage: string;
      upload_state: string;
    }>(
      `select s.status,s.failure_stage,b.upload_state
       from recording_sessions s join browser_recordings b on b.session_id=s.id
       where s.id=$1`,
      [legacySession],
    );
    assert.deepEqual(legacyLocal.rows[0], {
      status: "failed",
      failure_stage: "unsupported_format",
      upload_state: "local_only",
    });

    const interruptedSession = randomUUID();
    await db.query(
      `insert into recording_sessions(id,kiosk_id,court_id,idempotency_key,status,configuration_snapshot,recipient_email,started_at,stopped_at)
       values($1,$2,$3,gen_random_uuid(),'requested','{}','recovery@gmail.com',now()-interval '65 seconds',now())`,
      [interruptedSession, kiosks[0], courts[0]],
    );
    await db.query(
      `insert into browser_recordings(session_id,device_id,upload_state,client_created_at,duration_ms,local_available)
       values($1,$2,'saved_locally',now(),65000,true)`,
      [interruptedSession, devices[0]],
    );
    await db.query(
      "update kiosk_devices set current_session_id=$1 where id=$2",
      [interruptedSession, kiosks[0]],
    );
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select browser_event($1,$2,'failed') ok",
          [kiosks[0], interruptedSession],
        )
      ).rows[0].ok,
      true,
    );
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select browser_event($1,$2,'saved',2000,'video/mp4') ok",
          [kiosks[0], interruptedSession],
        )
      ).rows[0].ok,
      true,
      "finalized footage remains recoverable after capture interruption",
    );
    assert.equal(
      (
        await db.query<{ held: boolean }>(
          "select hold_short_browser_recording($1,$2,65000) held",
          [interruptedSession, devices[0]],
        )
      ).rows[0].held,
      false,
      "interrupted footage over one minute remains eligible for upload",
    );
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select queue_browser_upload($1,$2) ok",
          [interruptedSession, devices[0]],
        )
      ).rows[0].ok,
      true,
    );
    assert.deepEqual(
      (
        await db.query<{ status: string; upload_state: string; local_available: boolean }>(
          `select s.status,b.upload_state,b.local_available
           from recording_sessions s join browser_recordings b on b.session_id=s.id
           where s.id=$1`,
          [interruptedSession],
        )
      ).rows[0],
      { status: "uploading", upload_state: "pending", local_available: true },
    );

    const stale = randomUUID();
    await db.query(`insert into recording_sessions(id,kiosk_id,court_id,idempotency_key,status,configuration_snapshot,recipient_email)
      values($1,$2,$3,gen_random_uuid(),'recording','{}','stale@example.com')`, [stale,kiosks[0],courts[0]]);
    await db.query("insert into browser_recordings(session_id,device_id,upload_state,local_available) values($1,$2,'failed',true)", [stale,devices[0]]);
    await db.query("update kiosk_devices set current_session_id=$1 where id=$2", [stale,kiosks[0]]);
    assert.equal((await db.query<{ok:boolean}>("select cancel_browser_upload($1,$2) ok", [stale,devices[0]])).rows[0].ok, false,
      "a failed upload flag alone cannot cancel a live recording");
    await assert.rejects(db.query("select remove_browser_device($1,$2)", [devices[0],admin]), /active recording/);
    assert.equal((await db.query<{active:boolean}>("select active from kiosk_devices where id=$1", [kiosks[0]])).rows[0].active, true,
      "failed removal must preserve enrollment");
    await db.query("update recording_sessions set status='finalizing',stopped_at=now() where id=$1", [stale]);
    assert.equal((await db.query<{ok:boolean}>("select cancel_browser_upload($1,$2) ok", [stale,devices[1]])).rows[0].ok, false);
    assert.equal((await db.query<{ok:boolean}>("select cancel_browser_upload($1,$2) ok", [stale,devices[0]])).rows[0].ok, true);
    assert.deepEqual((await db.query("select status,failure_stage from recording_sessions where id=$1", [stale])).rows[0],
      {status:'failed',failure_stage:'upload_cancelled'});
    assert.equal((await db.query<{current_session_id:string|null}>("select current_session_id from kiosk_devices where id=$1", [kiosks[0]])).rows[0].current_session_id, null);
    // Removal also works directly, without requiring cancellation first.
    await db.query("update recording_sessions set status='finalizing' where id=$1", [stale]);
    await db.query("update browser_recordings set upload_state='failed' where session_id=$1", [stale]);
    assert.equal((await db.query<{ok:boolean}>("select remove_browser_device($1,$2) ok", [devices[0],admin])).rows[0].ok, true);
    assert.deepEqual((await db.query("select device_id,local_available from browser_recordings where session_id=$1", [stale])).rows[0],
      {device_id:null,local_available:true});
    assert.equal((await db.query<{active:boolean}>("select active from kiosk_devices where id=$1", [kiosks[0]])).rows[0].active, false);

    await db.query("delete from courts where id=$1", [courts[0]]);
    assert.equal(
      (
        await db.query<{ count: number }>(
          "select count(*)::int count from recording_sessions where id=any($1) and court_id is null",
          [sessions],
        )
      ).rows[0].count,
      3,
      "completed, failed, and uploading history does not block device or court removal",
    );
  } finally {
    await db.close();
  }
});
