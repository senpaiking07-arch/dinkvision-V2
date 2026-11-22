import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {InputError} from '../lib/validation';
import * as crypto from 'node:crypto';
import * as optionalSchema from '../lib/optional-schema';
import {qrEnrollmentPath} from '../lib/tablet-enrollment';

const source=ts.transpileModule(readFileSync(new URL('../app/api/admin/tablets/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
test('creating a code for a registered device requires explicit replacement and leaves its credential untouched',async()=>{
  const writes:any[]=[],exports:any={};
  runInNewContext(source,{exports,Date,require(name:string){
    if(name==='@/lib/auth')return{getAccount:async()=>({account:{id:'admin',role: 'admin', tenantId: '00000000-0000-4000-8000-000000000001'}})};
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

test('a replacement issues the same 12-character code in the QR and the manual field on the legacy schema', async () => {
  const exports: {POST?: (request: Request) => Promise<Response>} = {};
  const writes: Record<string, unknown>[] = [];
  let qrPayload = '';
  const hashKiosk = (code: string) => crypto.createHash('sha256').update(code).digest('hex');
  runInNewContext(source, {exports, Date, URL, require(name: string) {
    if (name === 'node:crypto') return crypto;
    if (name === '@/lib/auth') return {getAccount: async () => ({account: {id: 'admin', role: 'admin', tenantId: '00000000-0000-4000-8000-000000000001'}})};
    if (name === '@/lib/validation') return {InputError, uuid: (id: string) => id};
    if (name === '@/lib/http') return {sameOrigin: () => true, readBody: (request: Request) => request.json(),
      json: (body: unknown, status = 200) => Response.json(body, {status})};
    if (name === '@/lib/kiosk') return {hashKiosk};
    if (name === '@/lib/tablet-enrollment') return {qrEnrollmentPath};
    if (name === '@/lib/optional-schema') return optionalSchema;
    if (name === 'qrcode') return {default: {toDataURL: async (value: string) => {
      qrPayload = value;
      return 'data:image/png;base64,AAAA';
    }}};
    if (name === '@/lib/recorder-server') return {recorderDatabase: () => ({from(table: string) {
      const query = {
        update(fields: Record<string, unknown>) { writes.push(fields); return query; },
        eq() { return query; }, select() { return query; },
        in() { return query; }, limit: async () => ({data: [], error: null}),
        single: async () => 'enrollment_qr_hash' in writes.at(-1)!
          ? {data: null, error: {code: 'PGRST204', message: 'Missing enrollment_qr_hash'}}
          : {data: {id: 'tablet'}, error: null},
        insert() { assert.equal(table, 'audit_events'); return Promise.resolve({error: null}); },
      };
      return query;
    }})};
    return {};
  }});
  const origin = 'https://dinkvision.test';
  const response = await exports.POST!(new Request(origin + '/api/admin/tablets', {
    method: 'POST', headers: {origin, 'content-type': 'application/json'},
    body: JSON.stringify({action: 'enroll', replace_enrollment: true, id: 'tablet', name: 'Tablet'}),
  }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.code, /^[A-Za-z0-9_-]{12}$/);
  assert.match(result.qr, /^data:image\/png;base64,/);
  assert.equal(qrPayload, origin + '/tablet/enroll#code=' + result.code);
  assert.equal(result.pin, undefined);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].enrollment_qr_hash, null);
  assert.equal(writes[1].enrollment_hash, hashKiosk(result.code));
  assert.equal(writes[1].enrollment_expires_at, result.expiresAt);
});
