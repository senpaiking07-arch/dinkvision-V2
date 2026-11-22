import test from "node:test";
import assert from "node:assert/strict";
import { sendR2Video } from "../lib/r2-browser-upload";
import { R2_PART_SIZE,R2_UPLOAD_PROTOCOL } from "../lib/r2-protocol";

test("browser resumes at server offset, uploads directly and waits for verified completion",async()=>{
  const bytes=R2_PART_SIZE+23, calls:string[]=[],ranges:number[][]=[],progress:number[]=[];
  let accepted=false,finished=false;
  await sendR2Video({id:"session",bytes,grant:{protocol:R2_UPLOAD_PROTOCOL,attemptId:"attempt",bytes,partSize:R2_PART_SIZE,mime:"video/mp4"},
    request:async(action,fields)=>{
      calls.push(action);assert.equal(fields.attempt_id,"attempt");
      if(action==="upload-status") return accepted?{uploaded:true}:{offset:R2_PART_SIZE};
      if(action==="upload-part") {assert.equal(fields.part_number,2);return {offset:R2_PART_SIZE,length:23,url:"https://42c7c9ce788292c080caf0ad3e8daded.r2.cloudflarestorage.com/b/k?partNumber=2&uploadId=id&X-Amz-Signature=sig"};}
      assert.equal(action,"finish");finished=true;return {ready:true};
    },
    restart:async()=>{throw Error("unexpected restart");},
    range:async(start,end)=>{ranges.push([start,end]);return new Blob([new Uint8Array(end-start)]);},
    progress:async n=>{progress.push(n);if(n===bytes)assert.equal(finished,true);},
    transport:async(_url,init)=>{assert.equal(init?.credentials,"omit");assert.equal(init?.redirect,"error");accepted=true;return new Response(null,{status:200});},
  });
  assert.deepEqual(ranges,[[R2_PART_SIZE,bytes]]);
  assert.deepEqual(calls,["upload-status","upload-part","upload-status","finish"]);
  assert.deepEqual(progress,[R2_PART_SIZE,bytes]);
});

test("successful parts with unconfirmed completion remain recoverable",async()=>{
  const bytes=20;
  await assert.rejects(sendR2Video({id:"session",bytes,grant:{protocol:R2_UPLOAD_PROTOCOL,attemptId:"attempt",bytes,partSize:R2_PART_SIZE,mime:"video/mp4"},
    request:async action=>action==="upload-status"?{uploaded:true}:{ready:false},restart:async()=>({}),
    range:async()=>{throw Error("unexpected byte read");},progress:async()=>{throw Error("must not claim completion");},
  }),/confirmation is pending/);
});
