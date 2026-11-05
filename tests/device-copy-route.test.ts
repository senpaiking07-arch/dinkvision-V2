import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{runInNewContext}from'node:vm';import ts from'typescript';import{InputError}from'../lib/validation';
const source=ts.transpileModule(readFileSync(new URL('../app/api/tablet/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
async function receipt(owned=true,bytes:unknown=2048){const writes:any[]=[],filters:any[]=[];const exports:any={};
 runInNewContext(source,{exports,Date,require(name:string){
  if(name==='@/lib/browser-tablets')return{browserTablet:async()=>({device:{id:'own-device'},kiosk:{id:'kiosk',tenant_id:'own-tenant'}})};
  if(name==='@/lib/validation')return{InputError,uuid:(id:string)=>id};
  if(name==='@/lib/http')return{sameOrigin:()=>true,readBody:async()=>({action:'device-copy',id:'session',bytes,device_id:'forged',saved_at:'client time'}),json:(body:unknown,status=200)=>Response.json(body,{status})};
  if(name==='@/lib/recorder-server')return{recorderDatabase:()=>({from:(table:string)=>{const q={select:()=>q,update:(patch:any)=>{writes.push({table,patch});return q;},eq:(key:string,value:string)=>{filters.push([table,key,value]);return q;},maybeSingle:async()=>({data:owned?{session_id:'session'}:null,error:null}),then:(resolve:any)=>resolve({error:null})};return q;}})};
  return{};
 }});return{response:await exports.POST(new Request('http://localhost/api/tablet',{method:'POST'})),writes,filters};}
test('a device copy receipt updates only the authenticated owner with server time',async()=>{const{response,writes,filters}=await receipt();assert.equal(response.status,200);const copy=writes.find(x=>x.table==='browser_recordings');assert.equal(copy.patch.device_copy_bytes,2048);assert.notEqual(copy.patch.device_copy_saved_at,'client time');assert.ok(filters.some(([t,k,v]:string[])=>t==='browser_recordings'&&k==='device_id'&&v==='own-device'));});
test('foreign recordings and invalid copy sizes cannot create export receipts',async()=>{for(const[owned,bytes]of[[false,2048],[true,-1],[true,2.5],[true,'invalid']]as const){const{response,writes}=await receipt(owned,bytes);assert.ok(response.status>=400);assert.equal(writes.some(x=>x.table==='browser_recordings'),false);}});
