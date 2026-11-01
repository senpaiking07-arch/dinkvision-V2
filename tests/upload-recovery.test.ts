import test from "node:test";
import assert from "node:assert/strict";
import { videoRetryLabel } from "../lib/upload-recovery";

test("failed native validation can be retried before an upload file exists", () => {
  const failed = {
    upload_state: "failed", local_available: true, file_id: null, bytes: null,
    recording_sessions: { status: "uploading", stopped_at: "2026-11-01T00:00:00Z" },
  };
  assert.equal(videoRetryLabel(failed, true), "Retry processing");
  assert.equal(videoRetryLabel(failed), null, "pre-upload processing recovery is native-only");
  assert.equal(videoRetryLabel({ ...failed, local_available: false }, true), null);
  assert.equal(videoRetryLabel({ ...failed, recording_sessions: { status: "recording" } }, true), null);
  assert.equal(videoRetryLabel({ ...failed, recording_sessions: { status: "ready" } }, true), null);
  assert.equal(videoRetryLabel({ ...failed, recording_sessions: { status: "failed", failure_stage: "short_recording", stopped_at: failed.recording_sessions.stopped_at } }, true), null);
  assert.equal(videoRetryLabel({ ...failed, file_id: "file", bytes: 2048 }), "Retry upload");
});
