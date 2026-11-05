import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {InputError} from '../lib/validation';

const source=ts.transpileModule(readFileSync(new URL('../app/api/admin/tablets/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
test('creating a code for a registered device requires explicit replacement and leaves its credential untouched',async()=>{
  const writes:any[]=[],exports:any={};
  runInNewContext(source,{exports,Date,require(name:string){
    if(name==='@/lib/auth')return{getAccount:async()=>({account:{id:'admin',role:'admin'}})};
    if(name==='@/lib/validation')return{InputError,uuid:(id:string)=>id};
    if(name==='@/lib/http')return{sameOrigin:()=>true,readBody:async()=>({action:'enroll',id:'device',name:'Existing device'}),json:(body:unknown,status=200)=>Response.json(body,{status})};
    if(name==='@/lib/recorder-server')return{recorderDatabase:()=>({from:(table:string)=>{
      const q:any={select:()=>q,eq:()=>q,in:()=>q,limit:()=>q,update:(patch:any)=>{writes.push(patch);return q;},single:async()=>({data:table==='browser_devices'?{kiosk_id:'existing-kiosk'}:{active:true},error:null}),then:(resolve:any)=>resolve({data:[],error:null})};return q;
    }})};
    return{};
  }});
  const response=await exports.POST(new Request('http://localhost/api/admin/tablets',{method:'POST'}));
  assert.equal(response.status,409);assert.equal((await response.json()).replacementRequired,true);assert.equal(writes.length,0);
});
