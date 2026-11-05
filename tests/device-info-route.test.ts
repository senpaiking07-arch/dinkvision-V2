import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import ts from "typescript";
import {deviceInfoInput} from "../lib/device-info";
import {InputError} from "../lib/validation";
const source=ts.transpileModule(readFileSync(new URL("../app/api/tablet/route.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const info={platform:"android",manufacturer:"samsung",model:"SM-A226B",android_version:"13",android_sdk:33,app_version:"0.5.33",app_version_code:39,usb_cameras:[]};
async function heartbeat(value:unknown,missingColumn=false){
  const writes:any[]=[];const filters:any[]=[];const exports:any={};
  runInNewContext(source,{exports,Date,require(name:string){
    if(name==='@/lib/browser-tablets')return {browserTablet:async()=>({device:{id:'own-device'},kiosk:{id:'own-kiosk',tenant_id:'own-tenant',current_session_id:null}})};
    if(name==='@/lib/device-info')return {deviceInfoInput};
    if(name==='@/lib/validation')return {InputError};
    if(name==='@/lib/http')return {sameOrigin:()=>true,readBody:async()=>({action:'heartbeat',device_info:value,id:'forged-other-device'}),json:(body:unknown,status=200)=>Response.json(body,{status})};
    if(name==='@/lib/recorder-server')return {recorderDatabase:()=>({from:()=>{const q={update:(fields:any)=>{writes.push(fields);return q;},eq:(key:string,value:string)=>{filters.push([key,value]);return q;},then:(resolve:any)=>resolve({error:missingColumn&&writes.length===1?{code:'42703'}:null})};return q;}})};
    return {};
  }});
  return {response:await exports.POST(new Request('http://localhost/api/tablet',{method:'POST'})),writes,filters};
}
test('inventory heartbeat updates only its authenticated tablet and uses server report time',async()=>{
  const {response,writes,filters}=await heartbeat({...info,reported_at:'forged client time'});assert.equal(response.status,200);
  assert.equal(writes[0].device_info.model,'SM-A226B');assert.notEqual(writes[0].device_info.reported_at,'forged client time');
  assert.ok(filters.some(([k,v]:string[])=>k==='id'&&v==='own-device'));assert.ok(!filters.some(([,v]:string[])=>v==='forged-other-device'));
});
test('an older database still accepts heartbeat while optional inventory migration is pending',async()=>{
  const {response,writes}=await heartbeat(info,true);assert.equal(response.status,200);assert.equal(writes.length,2);assert.equal('device_info' in writes[1],false);
});
test('invalid device details are rejected without writing to another device',async()=>{
  const {response,writes}=await heartbeat({...info,model:'x'.repeat(81)});assert.ok(response.status>=400);assert.equal(writes.length,0);
});
