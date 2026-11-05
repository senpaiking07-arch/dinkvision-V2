import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const script=readFileSync(new URL("../android/app/src/main/assets/app.js",import.meta.url),"utf8");
const body=script.match(/function (format(?:Remaining|Recording)Time)\(maxSeconds, elapsedMillis\) \{[\s\S]*?\n\}/)!;
const timer=runInNewContext(`${body[0]};${body[1]}`) as (limit:number,elapsed:number)=>string;

test("Android recording timer counts up from zero to the configured limit",()=>{
  assert.equal(timer(900,0),"00:00");
  assert.equal(timer(900,999),"00:00");
  assert.equal(timer(900,1000),"00:01");
  assert.equal(timer(900,61999),"01:01");
  assert.equal(timer(900,899999),"14:59");
  assert.equal(timer(900,900000),"15:00");
});
test("timer clamps delayed UI frames to 15-, 20- and 25-minute limits",()=>{
  for(const seconds of [900,1200,1500])assert.equal(timer(seconds,seconds*1000+5000),`${seconds/60}:00`);
  assert.equal(timer(900,-100),"00:00");
});
