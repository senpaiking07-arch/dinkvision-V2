import test from "node:test";
import assert from "node:assert/strict";
import { recordingDisplayLabel } from "../lib/recording-label";
import { recordingDownloadFilename } from "../lib/recording-filename";

test("queue names show venue date and compact recipients with all four available", () => {
  const emails = ["one@gmail.com", "two@gmail.com", "three@gmail.com", "four@gmail.com"];
  const label = recordingDisplayLabel({ created_at: "2026-11-01T16:30:00Z",
    configuration_snapshot: { recipient_emails: emails, venue_time_zone: "Asia/Manila" } });
  assert.match(label.date, /Nov 2, 2026/);
  assert.equal(label.recipients, "one@gmail.com +3 more");
  for (const email of emails) assert.ok(label.full.includes(email));
});

test("legacy single recipients and long addresses remain identifiable", () => {
  const email = "a-very-long-player-address-to-compress@gmail.com";
  const label = recordingDisplayLabel({ recipient_email: email, created_at: "2026-11-01T00:00:00Z" });
  assert.ok(label.recipients.length <= 36);
  assert.ok(label.recipients.includes("…"));
  assert.ok(label.full.includes(email));
  assert.equal(recordingDisplayLabel({ recipient_email: "player@gmail.com" }).recipients, "player@gmail.com");
});

test("missing dates or invalid venue zones do not expose an ID as the video name", () => {
  assert.equal(recordingDisplayLabel().full, "Date unavailable · Players not recorded");
  assert.doesNotThrow(() => recordingDisplayLabel({created_at:"2026-11-01T00:00:00Z",configuration_snapshot:{venue_time_zone:"invalid-zone"}}));
});

const sessionId = "a1b2c3d4-4c73-4c85-837c-8eb21eaf5ea1";
const fileId = "52976b30-5a79-464e-a80b-49f2358e041a";

test("download names use the saved start time and venue timezone, including midnight and daylight saving", () => {
  const file = { session_id: sessionId, id: fileId, uploaded_at: "2026-11-24T01:00:00Z" };
  const manila = { started_at: "2026-11-23T00:25:00.123+00:00", venue_time_zone: "Asia/Manila" };
  assert.equal(recordingDownloadFilename({ ...file, recording_sessions: manila }), `2026-11-23_08-25-00_${fileId}.mp4`);
  assert.equal(recordingDownloadFilename({ ...file, recording_sessions: { ...manila, started_at: "2026-11-22T16:00:00Z" } }),
    `2026-11-23_00-00-00_${fileId}.mp4`);
  const newYork = { started_at: "2026-07-24T12:30:05Z", venue_time_zone: "America/New_York" };
  assert.equal(recordingDownloadFilename({ ...file, recording_sessions: [newYork] }), `2026-07-24_08-30-05_${fileId}.mp4`);
  for (const venue_time_zone of [undefined, "invalid-zone"]) {
    assert.equal(recordingDownloadFilename({ ...file, recording_sessions: { ...manila, venue_time_zone } }),
      `2026-11-23_00-25-00_${fileId}.mp4`);
  }
});

test("download IDs disambiguate the same start time and fallbacks exclude untrusted text", () => {
  const started = { started_at: "2026-11-23T00:25:00Z" };
  assert.notEqual(recordingDownloadFilename({ id: fileId, session_id: sessionId, recording_sessions: started }),
    recordingDownloadFilename({ id: "3236c00a-6cda-4d40-bfb3-c2bccb95e8f9", session_id: sessionId, recording_sessions: started }));
  assert.equal(recordingDownloadFilename({ session_id: sessionId }), `dinkvision-replay_${sessionId}.mp4`);
  assert.equal(recordingDownloadFilename({ session_id: sessionId, recording_sessions: { started_at: "2026-11-23T00:25:00" } }),
    `dinkvision-replay_${sessionId}.mp4`);
  const unsafe = { session_id: 'customer@example.com"\r\nInjected', id: fileId, recipient_email: "customer@example.com" };
  assert.equal(recordingDownloadFilename(unsafe), `dinkvision-replay_${fileId}.mp4`);
  assert.equal(recordingDownloadFilename({ ...unsafe, id: undefined }), "dinkvision-replay.mp4");
});
