import test from'node:test';import assert from'node:assert/strict';import{recordingSizeMb,uploadSizeMb}from'../lib/recording-size';
test('Admin video size distinguishes unknown values from actual megabytes',()=>{
 for(const n of[undefined,null,0,-1,NaN,'invalid',true])assert.equal(recordingSizeMb(n),'Size not reported yet');
 assert.equal(recordingSizeMb(1048576),'1.0 MB');assert.equal(recordingSizeMb('686931853'),'655.1 MB');
 assert.equal(uploadSizeMb(1048576,10485760),'1.0 / 10.0 MB uploaded');
 assert.equal(uploadSizeMb(20971520,10485760),'10.0 / 10.0 MB uploaded');
 assert.equal(uploadSizeMb(-1,10485760),'0.0 / 10.0 MB uploaded');
});
