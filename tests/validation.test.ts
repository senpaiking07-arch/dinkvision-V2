import test from "node:test";
import assert from "node:assert/strict";
import { cameraInput, settingsInput, uuid, bool, MIN_RETENTION_DAYS, SECONDS_PER_DAY } from "../lib/validation";

const validSettings = { duration_minutes: 15, venue_time_zone: "Asia/Manila" };

test("settings reject invalid limits, fractional values, and invalid time zones", () => {
  for (const value of [0, 121, 1.5, "15", null])
    assert.throws(() =>
      settingsInput({
        duration_minutes: value,
        retention_hours: 24,
        venue_time_zone: "Asia/Manila",
      }),
    );
  assert.throws(() =>
    settingsInput({
      duration_minutes: 15,
      retention_hours: 0,
      venue_time_zone: "Asia/Manila",
    }),
  );
  assert.throws(() =>
    settingsInput({
      duration_minutes: 15,
      retention_hours: 24,
      venue_time_zone: "Not/AZone",
    }),
  );
  for (const [minutes, seconds] of [
    [15, 900],
    [20, 1200],
    [25, 1500],
  ] as const) {
    const result = settingsInput({
      duration_minutes: minutes,
      retention_hours: 24,
      venue_time_zone: "Asia/Manila",
    });
    assert.equal(result.max_duration_seconds, seconds);
    assert.equal(result.retention_seconds, 86400);
  }
});

test("retention accepts day-based settings and preserves fractional stored durations", () => {
  for (const [days, seconds] of [[1, 86400], [7, 604800], [14, 1209600], [30, 2592000], [0.5, 43200], [1.25, 108000]]) {
    assert.equal(settingsInput({ ...validSettings, retention_days: days }).retention_seconds, seconds);
  }
  for (const seconds of [3600, 3601, 23 * 3600, 25 * 3600, 2591999]) {
    assert.equal(settingsInput({ ...validSettings, retention_days: seconds / SECONDS_PER_DAY }).retention_seconds, seconds);
  }
});

test("retention keeps the legacy whole-hour API and rejects ambiguous or invalid input", () => {
  for (const hours of [1, 24, 25, 168, 720]) {
    assert.equal(settingsInput({ ...validSettings, retention_hours: hours }).retention_seconds, hours * 3600);
  }
  for (const hours of [0, -3, 1.5, 721, "24", null]) {
    assert.throws(() => settingsInput({ ...validSettings, retention_hours: hours }), /whole number/);
  }
  for (const days of [0, -7, MIN_RETENTION_DAYS - 0.00001, 30.00001, "7", "", null, NaN, Infinity]) {
    assert.throws(() => settingsInput({ ...validSettings, retention_days: days }), /between 1 hour and 30 days/);
  }
  assert.throws(() => settingsInput(validSettings), /Enter a video retention duration/);
  assert.throws(() => settingsInput({ ...validSettings, retention_days: 7, retention_hours: 24 }), /using one field/);
});

test("camera registration rejects connection secrets and invalid assignments", () => {
  const valid = {
    name: "Court camera",
    recorder_id: "30000000-0000-4000-8000-000000000001",
    court_id: "20000000-0000-4000-8000-000000000001",
    source_type: "network",
    device_reference: "garden-01",
    is_primary: true,
    enabled: true,
  };
  assert.equal(cameraInput(valid).device_reference, "garden-01");
  assert.equal(cameraInput(valid).audio_source, "");
  assert.equal(cameraInput({...valid, audio_source: "stream"}).audio_source, "stream");
  assert.throws(() => cameraInput({...valid, source_type: "usb", audio_source: "stream"}));
  assert.throws(() => cameraInput({...valid, audio_source: "file:///private"}));
  assert.throws(() =>
    cameraInput({
      ...valid,
      device_reference: "rtsp://user:password@host/feed",
    }),
  );
  assert.throws(() => cameraInput({ ...valid, court_id: "" }));
  assert.throws(() => cameraInput({ ...valid, enabled: "true" }));
  assert.throws(() => uuid("not-an-id"));
  assert.throws(() => bool(1));
});
