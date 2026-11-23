import test from "node:test";
import assert from "node:assert/strict";
import { cameraHealth } from "../lib/camera-health";

const now = Date.parse("2026-11-23T08:00:00Z");
const connected = { connected: true };
const camera = { name: "EMEET", manufacturer: "EMEET" };
const reportedAt = (offset: number) => new Date(now + offset).toISOString();
const device = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  kiosk_id: "kiosk",
  tested_at: new Date(now - 60_000).toISOString(),
  recorder_mode: "android_rtsp",
  device_info: { reported_at: reportedAt(-10_000), usb_cameras: [camera] },
  ...overrides,
});

test("a connected recorder with a fresh USB camera report and a passed test is camera ready", () => {
  const health = cameraHealth(device(), connected, now);
  assert.equal(health.state, "ready");
  assert.equal(health.label, "Camera ready");
  assert.equal(health.tone, "is-success");
});

test("a passed test does not mask a disconnected USB camera", () => {
  const health = cameraHealth(device({ device_info: { reported_at: reportedAt(-10_000), usb_cameras: [] } }), connected, now);
  assert.equal(health.state, "disconnected");
  assert.equal(health.label, "USB camera not detected");
  assert.equal(health.tone, "is-danger");
});

test("a fresh check-in with missing USB inventory leaves attachment unknown", () => {
  for (const info of [{ reported_at: reportedAt(-1000) }, { reported_at: reportedAt(-1000), usb_cameras: null }]) {
    assert.equal(cameraHealth(device({ device_info: info }), connected, now).state, "unknown");
  }
});

test("stale camera inventory is not treated as current readiness", () => {
  const health = cameraHealth(device({
    device_info: { reported_at: reportedAt(-180_000), usb_cameras: [camera] },
  }), connected, now);
  assert.equal(health.state, "stale");
  assert.equal(health.tone, "is-warning");
});

test("camera readiness is unknown while the recorder is offline", () => {
  const health = cameraHealth(device(), { connected: false }, now);
  assert.equal(health.state, "offline");
  assert.equal(health.label, "Camera tested · recorder offline");
});

test("an old APK without a hardware inventory can still show a passed camera test", () => {
  const health = cameraHealth(device({ device_info: null }), connected, now);
  assert.equal(health.state, "ready");
  assert.equal(health.label, "Camera tested");
});

test("a browser recorder with a passed test is reported without inventing USB telemetry", () => {
  const health = cameraHealth(device({ recorder_mode: "browser", device_info: null }), connected, now);
  assert.equal(health.state, "ready");
  assert.equal(health.label, "Camera tested");
});

test("an attached but untested camera needs a check", () => {
  const health = cameraHealth(device({ tested_at: null }), connected, now);
  assert.equal(health.state, "untested");
  assert.equal(health.label, "Camera check needed");
});

test("disabled and unpaired recorders never claim camera readiness", () => {
  assert.equal(cameraHealth(device({ enabled: false }), connected, now).state, "disabled");
  assert.equal(cameraHealth(device({ kiosk_id: null }), connected, now).state, "unpaired");
});
