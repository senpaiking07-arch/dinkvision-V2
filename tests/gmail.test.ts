import test from "node:test";
import assert from "node:assert/strict";
import MailComposer from "nodemailer/lib/mail-composer";
import { readFileSync } from "node:fs";
import { recordingMessage } from "../lib/gmail";
const mimeFor = async (message: ReturnType<typeof recordingMessage>) => (await new MailComposer(message).compile().build()).toString();
const id="12345678-1234-1234-1234-123456789abc";
function plainPart(mime:string) {
  const part=mime.split(/\r\n--[^\r\n]+\r\n/).find(value=>/Content-Type: text\/plain/i.test(value));
  if (!part) throw new Error("missing plain email part");
  const body=part.split("\r\n\r\n")[1].split(/\r\n--/)[0];
  if (/Content-Transfer-Encoding: base64/i.test(part)) return Buffer.from(body.replace(/\r\n/g,""),"base64").toString();
  if (/Content-Transfer-Encoding: quoted-printable/i.test(part)) return Buffer.from(body.replace(/=\r\n/g,"").replace(/=([a-f0-9]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16))),"binary").toString();
  return body;
}
test("Email contains private replay link, Philippines deadline and no injected headers",async()=>{
  const raw=recordingMessage("owner@gmail.com","player@gmail.com",id,"drive12345","2026-10-02T00:00:00Z","Asia/Manila",true,undefined,"https://dinkvision-v2.vercel.app/replay/tenant/file?exp=1&sig=x");
  const mime=await mimeFor(raw);
  assert.match(mime,/To: player@gmail.com\r\n/);
  assert.doesNotMatch(mime,/Bcc:|Cc:/);
  const body=plainPart(mime);
  assert.match(body,/https:\/\/dinkvision-v2\.vercel\.app\/replay\/tenant\/file\?exp=1&sig=x/);
  assert.match(body,/Asia\/Manila/);
  assert.doesNotMatch(body,/drive\.google\.com/);
  assert.throws(()=>recordingMessage("owner@gmail.com","victim@gmail.com\r\nBcc: other@gmail.com",id,"drive12345","2026-10-02","Asia/Manila",true,undefined,"https://example.com/r"));
  assert.throws(()=>recordingMessage("owner@gmail.com","player@example.com",id,"drive12345","2026-10-02","Asia/Manila",true,undefined,"https://example.com/r"));
});
test("One replay message privately reaches all four team recipients",async()=>{
  const recipients=["one@gmail.com","two@gmail.com","three@gmail.com","four@gmail.com"];
  const raw=recordingMessage("owner@gmail.com",recipients,id,"drive12345","2026-10-02T00:00:00Z","Asia/Manila",true,undefined,"https://example.com/replay");
  const mime=await mimeFor(raw);
  assert.doesNotMatch(mime,/\r\nTo:/);
  assert.doesNotMatch(mime,/\r\nBcc:|\r\nCc:/);
  assert.deepEqual(raw.envelope.to,recipients);
  for (const recipient of recipients) assert.ok(!mime.includes(recipient));
  const body=plainPart(mime);
  assert.equal(body.match(/https:\/\/example\.com\/replay/g)?.length,1);
  assert.throws(()=>recordingMessage("owner@gmail.com",["one@gmail.com","one@gmail.com"],id,"drive12345","2026-10-02","Asia/Manila",true,undefined,"https://example.com/replay"));
});
test("recovered replay includes capture notice", () => {
  const replay = (code: unknown, durationMs: unknown) => recordingMessage(
    "owner@gmail.com", ["one@gmail.com"], id, "drive12345",
    "2026-10-02T00:00:00Z", "Asia/Manila", true, { code, durationMs }, "https://example.com/replay",
  );
  const camera = replay("camera_disconnected", 504_900);
  assert.match(camera.text, /camera disconnected during the match\. We recovered 8 minutes 24 seconds of footage\./);
  assert.match(camera.html, /camera disconnected during the match/);
  assert.match(camera.subject as string, /recording interrupted/);
});

test("R2 email uses current APK branding, an embedded logo and escaped replay links",async()=>{
  const message=recordingMessage("DinkVision <owner@gmail.com>","player@gmail.com",id,"","2026-11-24T00:00:00Z","Asia/Manila",true,undefined,"https://example.com/replay/token?exp=1&sig=x");
  assert.match(message.html,/#041d38/);
  assert.match(message.html,/#0bd6c1/);
  assert.match(message.html,/Your game\./);
  assert.match(message.html,/On replay\./);
  assert.match(message.html,/src="cid:dinkvision-logo"/);
  assert.match(message.html,/exp=1&amp;sig=x/);
  assert.doesNotMatch(message.html,/Sign in to Google|drive\.google\.com|#f4f2ea|Georgia/);
  assert.deepEqual(message.attachments?.[0].content,readFileSync("android/app/src/main/assets/dink-vision-logo.png"));
  const mime=await mimeFor(message);
  assert.match(mime,/Content-ID: <dinkvision-logo>/);
  assert.match(mime,/Content-Type: image\/png/);
  assert.throws(()=>recordingMessage("Owner <owner@gmail.com>\r\nBcc: attacker@gmail.com","player@gmail.com",id,"","2026-11-24","Asia/Manila",true,undefined,"https://example.com/replay"));
  assert.throws(()=>recordingMessage("owner@gmail.com, attacker@gmail.com","player@gmail.com",id,"","2026-11-24","Asia/Manila",true,undefined,"https://example.com/replay"));
});
