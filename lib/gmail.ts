import { captureInterruptionNotice } from "./capture-interruption";
export class MailError extends Error {
  constructor(public code:string,public outcome:"retry"|"failed"|"unknown",public retryAfter=60000) { super(code); }
}
function email(value:string) {
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value) || /@example\.(com|net|org)$/i.test(value))
    throw new MailError("invalid_email_recipient","failed");
  return value;
}
export function recordingMessage(sender:string,recipient:string|string[],file:string,drive:string,expires:string,zone:string,linkAccess=false,
  interruption?: { code: unknown; durationMs: unknown }, privateReplayUrl?: string) {
  email(sender);
  const recipients=(Array.isArray(recipient)?recipient:[recipient]).map(value=>email(value.trim().toLowerCase()));
  if (!recipients.length || new Set(recipients).size!==recipients.length || recipients.length>4)
    throw new MailError("invalid_email_recipient","failed");
  if (!/^[a-f0-9-]{36}$/.test(file)) throw new MailError("invalid_recording","failed");
  const deadline = new Intl.DateTimeFormat("en-PH",{timeZone:zone,dateStyle:"medium",timeStyle:"short"}).format(new Date(expires));
  const accessNote=linkAccess
    ? "Anyone with this link can watch. Only forward it to people you want to share your recording with."
    : recipients.length===1
      ? `Sign in to Google as ${recipients[0]} to view this private recording.`
      : "Sign in using one of the recipient Google accounts to view this private recording.";
  if(privateReplayUrl) {
    const url=new URL(privateReplayUrl);
    if(!["https:","http:"].includes(url.protocol) || url.username || url.password || !url.pathname.startsWith("/replay"))
      throw new MailError("invalid_replay_link","failed");
  }
  const replayUrl = privateReplayUrl || "";
  const replayOpenUrl = replayUrl;
  const playbackNote = "Watch or download your video from the replay page.";
  if (!replayUrl) throw new MailError("invalid_replay_link", "failed");
  const notice = captureInterruptionNotice(interruption?.code, interruption?.durationMs);
  const subject = notice
    ? "Your DinkVision replay is ready =?UTF-8?B?4oCU?= recording interrupted"
    : "Your Dink Vision match recording is ready";
  const body = `Your Dink Vision match recording is ready.\n\n${notice ? `${notice}\n\n` : ""}Watch your recording:\n${replayUrl}\n\n${accessNote}\n${playbackNote}\n\nPlease save a copy before ${deadline} (${zone}), the scheduled retention deadline.\n\nEnjoy your replay!\nDink Vision`;
  const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,(character)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[character]!));
  const html=`<!doctype html><html><body style="margin:0;background:#f4f2ea;color:#173f43;font-family:Arial,Helvetica,sans-serif;">
<div style="padding:30px 14px;background:#f4f2ea;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:620px;margin:0 auto;background:#fffef9;border:1px solid #dbe3d6;border-radius:18px;overflow:hidden;">
<tr><td style="padding:26px 30px 20px;background:#0b6467;color:#fffef9;"><div style="font-family:Georgia,serif;font-size:15px;letter-spacing:3px;font-weight:bold;">Dink Vision</div><div style="margin-top:6px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#cfe5d9;">Dink Vision</div></td></tr>
<tr><td style="padding:30px;"><div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#6d8275;font-weight:bold;">Match replay ready</div><h1 style="margin:10px 0 12px;font-family:Georgia,serif;font-size:31px;line-height:1.15;font-weight:normal;color:#123f43;">Your recording is ready.</h1><p style="margin:0 0 20px;color:#526b69;font-size:15px;line-height:1.55;">Your Dink Vision replay has finished processing.</p>
${notice ? `<p style="margin:0 0 20px;padding:15px 16px;border-radius:10px;background:#f4f2ea;color:#173f43;font-size:15px;line-height:1.55;">${escapeHtml(notice)}</p>` : ""}
<p style="margin:20px 0 0;text-align:center;"><a href="${escapeHtml(replayOpenUrl)}" style="display:inline-block;padding:13px 23px;border-radius:8px;background:#0b6467;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;">Watch your recording&nbsp; →</a></p>
<div style="margin-top:24px;padding:15px 16px;border-radius:10px;background:#eef4ea;color:#526b69;font-size:13px;line-height:1.55;">${escapeHtml(accessNote)}<br>${escapeHtml(playbackNote)}</div>
<p style="margin:20px 0 0;color:#526b69;font-size:13px;line-height:1.55;">Please save a copy before <strong style="color:#173f43;">${escapeHtml(deadline)} (${escapeHtml(zone)})</strong>, the scheduled retention deadline.</p></td></tr>
<tr><td style="padding:18px 30px;border-top:1px solid #e3e8df;color:#82918a;font-size:12px;line-height:1.5;">Enjoy your replay!<br><strong style="color:#52706c;">Dink Vision</strong><br><span>Powered by Dink Vision PH</span></td></tr>
</table></div></body></html>`;
  const boundary=`----=_DinkVision_${file.replace(/[^a-z0-9]/gi,"")}`;
  // Gmail rejects the empty RFC group form ("undisclosed-recipients:;") for
  // some API messages. A Bcc-only message is valid, reaches every submitted
  // address once, and keeps players' email addresses private from each other.
  const destination=recipients.length===1
    ? [`To: ${recipients[0]}`]
    : [`Bcc: ${recipients.join(", ")}`];
  const multipart=[
    `--${boundary}`,"Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: base64","",Buffer.from(body).toString("base64").match(/.{1,76}/g)!.join("\r\n"),"",
    `--${boundary}`,"Content-Type: text/html; charset=UTF-8","Content-Transfer-Encoding: 8bit","",html,"",
    `--${boundary}--`,
  ].join("\r\n");
  return Buffer.from([
    `From: Dink Vision <${sender}>`,...destination,`Subject: ${subject}`,
    `Message-ID: <dinkvision-${file}@${sender.split("@")[1]}>`,
    "MIME-Version: 1.0",`Content-Type: multipart/alternative; boundary="${boundary}"`,"",multipart,
  ].join("\r\n")).toString("base64url");
}
