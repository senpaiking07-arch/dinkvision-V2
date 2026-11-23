import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import ts from "typescript";
import {androidRelease, androidUpdateRequired} from "../lib/android-release";

const env = {ANDROID_REQUIRE_LATEST:"true",ANDROID_APK_DOWNLOAD_URL:"https://dinkvision.vercel.app/downloads/recorder.apk"};
const policy = androidRelease(env);
test("release version and Gradle share one manifest; enforcement starts only with an approved HTTPS download", () => {
  assert.equal(androidRelease({}).required, false);
  // Installed recorders validate the policy label even when updates are optional.
  assert.match(policy.versionName, /^\d+\.\d+\.\d+$/);
  assert.ok(Number.isInteger(policy.versionCode) && policy.versionCode > 0);
  assert.match(readFileSync("android/app/build.gradle","utf8"), /recorder-release.json/);
  for (const url of ["", "http://example.com/file.apk", "https://user:secret@example.com/file.apk", "https://example.com/file.apk#fragment"])
    assert.throws(()=>androidRelease({...env,ANDROID_APK_DOWNLOAD_URL:url}));
});
test("old or missing native versions are gated, current/new versions and ordinary browser clients are not",()=>{
  const request=(code:string, native=true)=>new Request("https://example.com/api/tablet",{headers:{...(native?{"x-dinkvision-client":"android"}:{}),"x-dinkvision-version-code":code}});
  for(const code of ["",String(policy.versionCode-1),"-1","NaN",`${policy.versionCode}.5`])assert.ok(androidUpdateRequired(request(code),false,policy));
  for(const code of [String(policy.versionCode),String(policy.versionCode+1)])assert.equal(androidUpdateRequired(request(code),false,policy),null);
  assert.equal(androidUpdateRequired(request("" ,false),false,policy),null);
  assert.ok(androidUpdateRequired(request("",false),true,policy));
  assert.equal(androidUpdateRequired(request("1"),false,androidRelease({})),null);
});
test("server rejects an outdated APK start/enrollment before consuming a code or writing a session",async()=>{
  for(const path of ["app/api/tablet/route.ts","app/api/tablet/enroll/route.ts"]){
    const source=ts.transpileModule(readFileSync(path,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports:any={};let writes=0;
    runInNewContext(source,{exports,Date,URL,require(name:string){
      if(name==="@/lib/android-release")return{androidUpdateRequired:(r:Request,native:boolean)=>androidUpdateRequired(r,native,policy)};
      if(name==="@/lib/browser-tablets")return{browserTablet:async()=>({device:{recorder_mode:"android_camera"},kiosk:{}})};
      if(name==="@/lib/http")return{sameOrigin:()=>true,readBody:async()=>({action:"start"}),json:(body:unknown,status=200)=>Response.json(body,{status})};
      if(name==="@/lib/recorder-server")return{recorderDatabase:()=>({from:()=>{writes++;throw Error("must not write");}})};
      return{};
    }});
    const result=await exports.POST(new Request("https://example.com/api/tablet",{method:"POST",headers:{"x-dinkvision-client":"android","x-dinkvision-version-code":"40"}}));
    assert.equal(result.status,426,path);assert.equal((await result.json()).release.versionCode,policy.versionCode);assert.equal(writes,0);
  }
});
