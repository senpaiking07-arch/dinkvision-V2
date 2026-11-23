import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import MailComposer from "nodemailer/lib/mail-composer";
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

test("R2 email displays the public logo in the body without creating a MIME attachment",async()=>{
  const message=recordingMessage("DinkVision <owner@gmail.com>","player@gmail.com",id,"","2026-11-24T00:00:00Z","Asia/Manila",true,undefined,"https://dinkvision-v2.vercel.app/replay/token?exp=1&sig=x");
  assert.match(message.html,/#041d38/);
  assert.match(message.html,/#0bd6c1/);
  assert.match(message.html,/Your game\./);
  assert.match(message.html,/On replay\./);
  assert.match(message.html,/src="https:\/\/dinkvision-v2\.vercel\.app\/dink-vision-logo-email-dark\.png" alt="DinkVision"/);
  assert.match(message.html,/<td style="padding:0;">\s*<img\b/);
  assert.doesNotMatch(message.html,/bgcolor="#f5f9ff"/);
  assert.match(message.html,/exp=1&amp;sig=x/);
  assert.doesNotMatch(message.html,/Sign in to Google|drive\.google\.com|#f4f2ea|Georgia/);
  const mime=await mimeFor(message);
  assert.match(mime,/Content-Type: multipart\/alternative/i);
  assert.doesNotMatch(mime,/^Content-(?:Disposition|ID):|^Content-Type: image\//mi);
  assert.throws(()=>recordingMessage("Owner <owner@gmail.com>\r\nBcc: attacker@gmail.com","player@gmail.com",id,"","2026-11-24","Asia/Manila",true,undefined,"https://example.com/replay"));
  assert.throws(()=>recordingMessage("owner@gmail.com, attacker@gmail.com","player@gmail.com",id,"","2026-11-24","Asia/Manila",true,undefined,"https://example.com/replay"));
});

test("a local HTTP replay uses the DinkVision wordmark instead of an inaccessible image",()=>{
  const message=recordingMessage("owner@gmail.com","player@gmail.com",id,"","2026-11-24T00:00:00Z","Asia/Manila",true,undefined,"http://192.168.1.9:3000/replay/token");
  assert.match(message.html,/>Dink<span style="color:#00c9bc;">Vision<\/span><\/span>/);
  assert.doesNotMatch(message.html,/<img\b/);
});

test("the dark email logo retains visible light and teal lettering at display size", () => {
  assert.ok(ffmpeg, "A PNG decoder is required for the logo check");
  const pixels = execFileSync(ffmpeg, [
    "-loglevel", "error", "-i", "public/dink-vision-logo-email-dark.png",
    "-vf", "scale=144:-1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ]);
  let transparent = 0, light = 0, teal = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b, alpha] = pixels.subarray(i, i + 4);
    if (alpha < 10) transparent++;
    if (alpha > 200 && r > 180 && g > 180 && b > 180) light++;
    if (alpha > 200 && r < 80 && g > 150 && b > 140) teal++;
  }
  const area = pixels.length / 4;
  assert.ok(transparent > area * 0.5, "The background must let the navy header show through");
  assert.ok(light > area * 0.03 && teal > area * 0.05, "Both wordmark colors need solid coverage");
});
