import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{runInNewContext}from'node:vm';import ts from'typescript';import{InputError}from'../lib/validation';
const source=ts.transpileModule(readFileSync(new URL('../app/api/tablet/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
async function report(value:unknown,owned=true,status='saved_locally',serverStatus='saved_locally',action='queue-report'){const writes:any[]=[],filters:any[]=[],exports:any={};
 runInNewContext(source,{exports,Date,require(name:string){
  if(name==='@/lib/browser-tablets')return{browserTablet:async()=>({device:{id:'own-device'},kiosk:{id:'kiosk',tenant_id:'own-tenant'}})};
  if(name==='@/lib/validation')return{InputError,uuid:(id:string)=>id};
  if(name==='@/lib/http')return{sameOrigin:()=>true,readBody:async()=>({action,id:'session',status,branding_state:'processing',branding_progress:value}),json:(body:unknown,status=200)=>Response.json(body,{status})};
  if(name==='@/lib/recorder-server')return{recorderDatabase:()=>({from:(table:string)=>{const q:any={select:()=>q,update:(patch:any)=>{writes.push({table,patch});return q;},eq:(k:string,v:string)=>{filters.push([table,k,v]);return q;},in:(k:string,v:string[])=>{filters.push([table,k,v]);return q;},maybeSingle:async()=>({data:owned?{session_id:'session',upload_state:serverStatus}:null,error:null}),then:(resolve:any)=>resolve({error:null})};return q;}})};
  return{};
 }});return{response:await exports.POST(new Request('http://localhost/api/tablet',{method:'POST'})),writes,filters};}
test('measured logo progress updates only the authenticated device recording',async()=>{const{response,writes,filters}=await report(42);assert.equal(response.status,200);assert.equal(writes.find(x=>x.table==='browser_recordings').patch.branding_progress,42);assert.ok(filters.some(([t,k,v]:string[])=>t==='browser_recordings'&&k==='device_id'&&v==='own-device'));});
test('invalid percentages and foreign recordings cannot update logo progress',async()=>{for(const n of[-1,101,1.5,'42',true]){const{response,writes}=await report(n);assert.ok(response.status>=400);assert.equal(writes.some(x=>x.table==='browser_recordings'),false);}const foreign=await report(42,false);assert.equal(foreign.response.status,403);assert.equal(foreign.writes.some(x=>x.table==='browser_recordings'),false);});
test('metadata can reconcile a server-confirmed local-only clip without inventing a new policy',async()=>{
 assert.equal((await report(100,true,'local_only','local_only')).response.status,200);
 assert.equal((await report(100,true,'local_only','pending')).response.status,400);
});

test('waiting presence only refreshes contact for owned waiting files without resetting bytes or retries',async()=>{
 const {response,writes,filters}=await report(undefined,true,'retrying','retrying','queue-presence');
 assert.equal(response.status,200);
 assert.deepEqual(Object.keys(writes[0].patch),['last_seen_at']);
 assert.ok(filters.some(([t,k,v])=>t==='browser_recordings'&&k==='device_id'&&v==='own-device'));
 assert.ok(filters.some(([t,k,v])=>t==='browser_recordings'&&k==='local_available'&&v===true));
 assert.deepEqual(Array.from(filters.find(([,k])=>k==='upload_state')[2]),['saved_locally','pending','queued','retrying']);
 assert.equal((await report(undefined,false,'retrying','retrying','queue-presence')).response.status,403);
});
