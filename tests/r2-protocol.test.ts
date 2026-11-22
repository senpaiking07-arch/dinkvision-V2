import test from "node:test";
import assert from "node:assert/strict";
import { confirmedParts,R2_PART_SIZE,r2PartAddress } from "../lib/r2-protocol";
import { signReplay,verifyReplay } from "../lib/replay-token";
import { selectAccountTenant } from "../lib/account-tenant";
import { validateTestEnvironment,loadTestEnvironment } from "../scripts/r2-local-env.mjs";
import { mkdtemp,writeFile,mkdir,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("resume trusts contiguous full remote parts, including the short final part",()=>{
  const total=R2_PART_SIZE*2+17;
  const parts=[{PartNumber:1,Size:R2_PART_SIZE,ETag:'"one"'},{PartNumber:2,Size:R2_PART_SIZE,ETag:'"two"'},{PartNumber:3,Size:17,ETag:'"three"'}];
  assert.equal(confirmedParts(parts,total).offset,total);
  assert.equal(confirmedParts(parts,total).uploaded,true);
  assert.equal(confirmedParts([parts[0],parts[2]],total).offset,R2_PART_SIZE);
  assert.equal(confirmedParts([{...parts[0],Size:1000}],total).offset,0);
  assert.throws(()=>confirmedParts([parts[0],parts[0]],total));
  assert.throws(()=>confirmedParts([{...parts[0],PartNumber:4}],total));
});

test("signed part destinations reject redirects to untrusted hosts and credential URLs",()=>{
  const good="https://42c7c9ce788292c080caf0ad3e8daded.r2.cloudflarestorage.com/bucket/key?uploadId=id&partNumber=1&X-Amz-Signature=sig";
  assert.equal(r2PartAddress(good),good);
  for(const bad of [good.replace("https:","http:"),good.replace("cloudflarestorage.com","cloudflarestorage.com.evil.invalid"),good.replace("https://","https://user:pass@"),good+"#fragment"]) assert.throws(()=>r2PartAddress(bad));
});

test("guest replay tokens reject tampering, wrong keys, expired and malformed identities",()=>{
  const key=Buffer.alloc(32,1).toString("base64"), now=100000;
  const claims={v:1 as const,tenant:"00000000-0000-4000-8000-000000000001",file:"00000000-0000-4000-8000-000000000002",exp:200};
  const token=signReplay(claims,key);
  assert.deepEqual(verifyReplay(token,key,now),claims);
  assert.equal(verifyReplay(token,key,200000),null);
  assert.equal(verifyReplay(token,Buffer.alloc(32,2).toString("base64"),now),null);
  const changed=Buffer.from(JSON.stringify({...claims,tenant:"00000000-0000-4000-8000-000000000003"})).toString("base64url")+"."+token.split(".")[1];
  assert.equal(verifyReplay(changed,key,now),null);
  assert.equal(verifyReplay(token+".suffix",key,now),null);
  assert.throws(()=>signReplay({...claims,file:"not-a-file"},key));
});

test("tenant selection never promotes an unverified cookie or global profile role",()=>{
  const tenants=[{id:"a",name:"A",role:"player" as const},{id:"b",name:"B",role:"admin" as const}];
  assert.equal(selectAccountTenant(tenants,"unowned")?.id,"a");
  assert.equal(selectAccountTenant(tenants,"a")?.role,"player");
  assert.equal(selectAccountTenant(tenants,"b")?.role,"admin");
  assert.equal(selectAccountTenant([],"b"),undefined);
});

const config={NEXT_PUBLIC_SUPABASE_URL:"https://gwermdkkrotvvpoxkqdx.supabase.co",R2_ACCOUNT_ID:"42c7c9ce788292c080caf0ad3e8daded",R2_BUCKET:"dinkvision-videos-dev",APP_ORIGIN:"http://127.0.0.1:3000",REPLAY_ORIGIN:"http://192.168.1.9:3000",NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:"public-test",SUPABASE_SECRET_KEY:"secret-test",R2_ACCESS_KEY_ID:"access-test",R2_SECRET_ACCESS_KEY:"secret-test",TOKEN_ENCRYPTION_KEY:"test",REPLAY_SIGNING_KEY:"test",CRON_SECRET:"test"};
test("test commands reject production destinations and cannot inherit omitted secrets",async()=>{
  assert.doesNotThrow(()=>validateTestEnvironment(config,"dev"));
  for(const changed of [{R2_BUCKET:"production"},{NEXT_PUBLIC_SUPABASE_URL:"https://other.supabase.co"},{APP_ORIGIN:"https://dinkvision.vercel.app"},{MIGRATION_DATABASE_URL:"postgresql://postgres:password@db.other.supabase.co/postgres"}])
    assert.throws(()=>validateTestEnvironment({...config,...changed},"dev"));
  const root=await mkdtemp(join(tmpdir(),"dinkvision-r2-env-"));
  try {
    await mkdir(join(root,".local"));
    await writeFile(join(root,".env"),"GOOGLE_CLIENT_SECRET=production-secret\nUNEXPECTED_APP_SECRET=production-secret\n");
    await writeFile(join(root,".local/r2-test.env"),Object.entries(config).map(([k,v])=>`${k}=${v}`).join("\n"));
    const env=await loadTestEnvironment("dev",root);
    assert.equal(env.GOOGLE_CLIENT_SECRET,"");
    assert.equal(env.UNEXPECTED_APP_SECRET,"");
    assert.equal(env.SUPABASE_SECRET_KEY,"secret-test");
  } finally {await rm(root,{recursive:true,force:true});}
});
