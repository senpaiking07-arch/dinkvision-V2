import test from "node:test";
import assert from "node:assert/strict";
import { tabletCameraFields } from "../lib/tablet-camera-config";
import { decryptSecret } from "../lib/google-crypto";
test("admin RTSP configuration encrypts credentials and preserves saved passwords", () => {
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const body = {
    recorder_mode: "android_rtsp",
    camera_name: "C210",
    rtsp_host: "192.168.1.2",
    rtsp_username: "camera",
    rtsp_password: "fixture-password",
  };
  const fields = tabletCameraFields(body);
  assert.equal(fields.rtsp_url, "rtsp://192.168.1.2:554/stream1");
  assert.equal(fields.audio_device, "camera-audio");
  assert.notEqual(fields.rtsp_password_encrypted, body.rtsp_password);
  assert.equal(
    decryptSecret(fields.rtsp_password_encrypted!),
    body.rtsp_password,
  );
  assert.equal(
    tabletCameraFields({ ...body, rtsp_password: "" }, fields)
      .rtsp_password_encrypted,
    fields.rtsp_password_encrypted,
  );
  assert.throws(() => tabletCameraFields({ ...body, rtsp_password: "" }));
  for (const rtsp_host of [
    "example.com",
    "192.168.1.256",
    "rtsp://user:pass@192.168.1.2/stream1",
  ])
    assert.throws(() => tabletCameraFields({ ...body, rtsp_host }));
  assert.equal(
    tabletCameraFields({ recorder_mode: "browser" }, fields)
      .rtsp_password_encrypted,
    null,
  );
});

test("Android device camera uses the native recorder without RTSP credentials", () => {
  const fields = tabletCameraFields({ recorder_mode: "android_camera" });
  assert.equal(fields.recorder_mode, "android_rtsp");
  assert.equal(fields.video_device, "android-camera-v1");
  assert.equal(fields.audio_device, "device-microphone");
  assert.equal(fields.camera_name, "Android built-in camera");
  assert.equal(fields.rtsp_url, "");
  assert.equal(fields.rtsp_password_encrypted, null);
});
