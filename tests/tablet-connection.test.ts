import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{runInNewContext}from'node:vm';import ts from'typescript';
const source=ts.transpileModule(readFileSync('app/api/tablet/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
async function state(unavailable:boolean){
 const exports:any={};runInNewContext(source,{exports,URL,console:{error(){}},require(name:string){
   if(name==='@/lib/browser-tablets')return{browserTablet:async()=>{if(unavailable)throw Object.assign(Error('Fixture database unavailable'),{code:'08006'});return null;}};
   if(name==='@/lib/http')return{json:(body:unknown,status=200)=>Response.json(body,{status})};
   if(name==='@/lib/venue-errors')return{venueStateError:()=> 'Tablet connection unavailable. Please retry.'};
   return{};
 }});return exports.GET(new Request('https://dinkvision.vercel.app/api/tablet'));
}
test('hosted database outages return a retryable failure instead of reporting the device unenrolled',async()=>{
 const outage=await state(true);assert.equal(outage.status,503);assert.equal((await outage.json()).enabled,undefined);
 const revoked=await state(false);assert.equal(revoked.status,200);assert.equal((await revoked.json()).enabled,false);
});
