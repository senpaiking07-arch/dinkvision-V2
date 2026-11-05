import test from "node:test";
import assert from "node:assert/strict";
import { recordingDisplayLabel } from "../lib/recording-label";

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
