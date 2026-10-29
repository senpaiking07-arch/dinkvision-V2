import test from "node:test";
import assert from "node:assert/strict";
import {
  nativeTabletCameraFields,
  tabletCameraFields,
} from "../lib/tablet-camera-config";
test("Tapo and arbitrary RTSP configuration are no longer accepted", () => {
  assert.throws(
    () => tabletCameraFields({ recorder_mode: "android_rtsp" }),
    /valid recorder type/,
  );
  assert.throws(
    () => nativeTabletCameraFields({ recorder_mode: "android_rtsp" }),
    /USB or built-in/,
  );
});

test("Android device camera uses the native recorder without RTSP credentials", () => {
  const fields = nativeTabletCameraFields({ recorder_mode: "android_camera" });
  assert.equal(fields.recorder_mode, "android_rtsp");
  assert.equal(fields.video_device, "android-camera-v1");
  assert.equal(fields.audio_device, "device-microphone");
  assert.equal(fields.camera_name, "Android USB / built-in camera");
  assert.equal(fields.rtsp_url, "");
  assert.equal(fields.rtsp_password_encrypted, null);
});

test("an enrolled native recorder cannot switch itself to browser recording", () => {
  assert.throws(
    () => nativeTabletCameraFields({ recorder_mode: "browser" }),
    /USB or built-in Android camera/,
  );
});
