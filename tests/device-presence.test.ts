import test from "node:test";
import assert from "node:assert/strict";
import {devicePresence} from "../lib/device-presence";
test("device presence distinguishes delayed contact from confirmed disablement",()=>{
  const now=Date.parse('2026-11-02T00:00:00Z'),d={enabled:true,kiosk_id:'kiosk',last_seen_at:new Date(now-5000).toISOString()};
  assert.equal(devicePresence(d,now).connected,true);
  assert.equal(devicePresence({...d,last_seen_at:new Date(now-60000).toISOString()},now).label,'Contact delayed');
  assert.equal(devicePresence({...d,last_seen_at:new Date(now-300000).toISOString()},now).label,'No recent contact');
  assert.equal(devicePresence({...d,enabled:false},now).label,'Disabled');
  assert.equal(devicePresence({...d,last_seen_at:new Date(now+60000).toISOString()},now).connected,false);
});
