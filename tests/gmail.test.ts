import test from "node:test";
import assert from "node:assert/strict";
import { recordingMessage, MailError } from "../lib/gmail";
const id="12345678-1234-1234-1234-123456789abc";
function plainPart(mime:string) {
  const part=mime.split(/\r\n--[^\r\n]+\r\n/).find(value=>/Content-Type: text\/plain/i.test(value));
  if (!part) throw new Error("missing plain email part");
  return Buffer.from(part.split("\r\n\r\n")[1].split(/\r\n--/)[0].replace(/\r\n/g,""),"base64").toString();
}
test("Email contains private replay link, Philippines deadline and no injected headers",()=>{
  const raw=recordingMessage("owner@gmail.com","player@gmail.com",id,"drive12345","2026-10-02T00:00:00Z","Asia/Manila",true,undefined,"https://dinkvision-v2.vercel.app/replay/tenant/file?exp=1&sig=x");
  const mime=Buffer.from(raw,"base64url").toString();
  assert.match(mime,/To: player@gmail.com\r\n/);
  assert.doesNotMatch(mime,/Bcc:|Cc:/);
  const body=plainPart(mime);
  assert.match(body,/https:\/\/dinkvision-v2\.vercel\.app\/replay\/tenant\/file\?exp=1&sig=x/);
  assert.match(body,/Asia\/Manila/);
  assert.doesNotMatch(body,/drive\.google\.com/);
  assert.throws(()=>recordingMessage("owner@gmail.com","victim@gmail.com\r\nBcc: other@gmail.com",id,"drive12345","2026-10-02","Asia/Manila",true,undefined,"https://example.com/r"));
  assert.throws(()=>recordingMessage("owner@gmail.com","player@example.com",id,"drive12345","2026-10-02","Asia/Manila",true,undefined,"https://example.com/r"));
});
test("One replay message privately reaches all four team recipients",()=>{
  const recipients=["one@gmail.com","two@gmail.com","three@gmail.com","four@gmail.com"];
  const raw=recordingMessage("owner@gmail.com",recipients,id,"drive12345","2026-10-02T00:00:00Z","Asia/Manila",true,undefined,"https://example.com/replay");
  const mime=Buffer.from(raw,"base64url").toString();
  assert.doesNotMatch(mime,/\r\nTo:/);
  assert.match(mime,/Bcc: one@gmail.com, two@gmail.com, three@gmail.com, four@gmail.com\r\n/);
  const body=plainPart(mime);
  assert.equal(body.match(/https:\/\/example\.com\/replay/g)?.length,1);
  assert.throws(()=>recordingMessage("owner@gmail.com",["one@gmail.com","one@gmail.com"],id,"drive12345","2026-10-02","Asia/Manila",true,undefined,"https://example.com/replay"));
});
test("recovered replay includes capture notice", () => {
  const replay = (code: unknown, durationMs: unknown) => Buffer.from(recordingMessage(
    "owner@gmail.com", ["one@gmail.com"], id, "drive12345",
    "2026-10-02T00:00:00Z", "Asia/Manila", true, { code, durationMs }, "https://example.com/replay",
  ), "base64url").toString();
  const camera = replay("camera_disconnected", 504_900);
  assert.match(plainPart(camera), /camera disconnected during the match\. We recovered 8 minutes 24 seconds of footage\./);
  assert.match(camera, /recording interrupted/);
});
