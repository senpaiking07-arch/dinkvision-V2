import test from "node:test";
import assert from "node:assert/strict";
import { parseRecorderEvents, stageLabel, codeLabel } from "../lib/recorder-events";

const id = "11111111-1111-4111-8111-111111111111";
const event = () => ({event_id:id,attempt_id:id,session_id:null,operation:"capture",stage:"reserve",
  elapsed_ms:100,duration_ms:80,result:"failed",code:"timeout",occurred_at:"2026-11-11T00:00:00.000Z",
  queue_count:5,bytes:0,retry_count:0,version_code:49});
test("recorder diagnostics retain timing and failure evidence without accepting arbitrary text", () => {
  const parsed = parseRecorderEvents([event()]);
  assert.equal(parsed[0].duration_ms,80);
  assert.equal(parsed[0].queue_count,5);
  assert.throws(() => parseRecorderEvents([{...event(),message:"secret or email"}]));
  assert.throws(() => parseRecorderEvents([{...event(),url:"https://example.invalid?token=secret"}]));
});
test("diagnostic batches are bounded and reject bad identifiers, times, and enums", () => {
  for (const invalid of [[],Array(21).fill(event()),[{...event(),event_id:"bad"}],
    [{...event(),duration_ms:-1}],[{...event(),stage:"anything"}],[{...event(),code:"unknown secret"}],
    [{...event(),occurred_at:"invalid"}],[{...event(),bytes:Infinity}],
    [{...event(),result:"failed",code:"none"}]]) assert.throws(() => parseRecorderEvents(invalid));
  assert.throws(() => parseRecorderEvents([event(),event()]),"duplicate IDs inside a batch");
});
test("Admin explains observed symptoms without claiming a measured Wi-Fi speed", () => {
  assert.match(stageLabel("camera_prepare"),/Camera preparation/);
  assert.match(stageLabel("queue_wait"),/Waiting/);
  assert.match(codeLabel("timeout"),/timeout/i);
  assert.doesNotMatch(codeLabel("timeout"),/slow Wi-Fi|broken camera/i);
});

test("stage details and bounded transport metrics remain compatible with older events", () => {
  const [upload] = parseRecorderEvents([{...event(), operation:"upload", stage:"verify",
    http_status:503, acknowledged_bytes:1024, transferred_bytes:512, retry_delay_ms:5000}]);
  assert.equal(upload.http_status,503);
  assert.equal(upload.acknowledged_bytes,1024);
  assert.match(stageLabel("verify"),/Verifying/);
  for (const invalid of [{http_status:600},{http_status:99},{transferred_bytes:-1},{retry_delay_ms:604800001}])
    assert.throws(() => parseRecorderEvents([{...event(),...invalid}]));
});

test("recorder actions accept only supported sources and bounded repeat counts", () => {
  const [row] = parseRecorderEvents([{...event(), stage:"stop_repeated", result:"ok", code:"none",
    action_source:"notification", repeated_actions:3}]);
  assert.equal(row.action_source,"notification");
  assert.equal(row.repeated_actions,3);
  for (const invalid of [{action_source:"untrusted"},{repeated_actions:0},{repeated_actions:1001}])
    assert.throws(() => parseRecorderEvents([{...event(),...invalid}]));
});
