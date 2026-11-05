import test from "node:test";
import assert from "node:assert/strict";
import {deviceInfoInput} from "../lib/device-info";
const report={platform:"android",manufacturer:"samsung",model:"SM-A226B",android_version:"13",android_sdk:33,app_version:"0.5.33",app_version_code:39,
  usb_cameras:[{name:"EMEET",manufacturer:"EMEET",vendor_id:1234,product_id:5678,serial:"never store this"}],serial:"private",reported_at:"client clock"};
test("device inventory stores only bounded non-unique device/camera details with server time",()=>{
  const clean=deviceInfoInput(report,"2026-11-01T19:30:00Z");
  assert.equal(clean.model,"SM-A226B");assert.equal(clean.usb_cameras[0].name,"EMEET");
  assert.equal(clean.reported_at,"2026-11-01T19:30:00Z");assert.equal("serial" in clean,false);assert.equal("serial" in clean.usb_cameras[0],false);
});
test("invalid inventory cannot inject oversized or unbounded camera data",()=>{
  for(const bad of [null,[],{...report,model:"x".repeat(81)},{...report,android_sdk:33.5},{...report,usb_cameras:Array(5).fill(report.usb_cameras[0])}])assert.throws(()=>deviceInfoInput(bad));
});
test("camera mode is a bounded target label alongside the real microphone route",()=>{
  const mode="1920 × 1080 · 60 fps target";
  assert.equal(deviceInfoInput({...report,recording_profile:mode}).recording_profile,mode);
  assert.throws(()=>deviceInfoInput({...report,recording_profile:"x".repeat(161)}));
});
