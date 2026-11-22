type ReplayEmailContent = { replayUrl: string; deadline: string; zone: string; accessNote: string; notice?: string | null; logoUrl?: string };

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));

export function replayEmailHtml(content: ReplayEmailContent) {
  const url = escapeHtml(content.replayUrl);
  const logo = content.logoUrl
    ? `<img src="${escapeHtml(content.logoUrl)}" alt="DinkVision" width="144" style="display:block;width:144px;height:auto;border:0;color:#041d38;font-size:22px;font-weight:bold;">`
    : `<span style="color:#041d38;font-size:22px;font-weight:bold;letter-spacing:-0.5px;">DinkVision</span>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your DinkVision replay</title>
<style>@media only screen and (max-width:480px){.email-pad{padding-left:24px!important;padding-right:24px!important}.replay-heading{font-size:40px!important}.email-outer{padding:16px 8px!important}}</style></head>
<body style="margin:0;padding:0;background:#021426;color:#f5f9ff;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">Your recording is ready. Watch your match and save a copy before ${escapeHtml(content.deadline)}.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#021426"><tr><td class="email-outer" align="center" style="padding:32px 12px;">
<!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#041d38" style="max-width:600px;border:1px solid #34526c;border-top:4px solid #0bd6c1;border-radius:16px;overflow:hidden;">
<tr><td class="email-pad" style="padding:24px 40px;border-bottom:1px solid #34526c;">
<table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="#f5f9ff" style="padding:6px 14px;border-radius:10px;">${logo}</td></tr></table>
</td></tr>
<tr><td class="email-pad" style="padding:36px 40px 32px;">
<p style="margin:0 0 16px;color:#d7ff42;font-size:11px;line-height:1.5;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">MATCH REPLAY READY</p>
<h1 class="replay-heading" style="margin:0 0 20px;color:#f5f9ff;font-family:'Arial Narrow',Arial,Helvetica,sans-serif;font-size:52px;line-height:1.02;font-weight:800;font-style:italic;letter-spacing:-1px;text-transform:uppercase;">Your game.<br><span style="color:#0bd6c1;">On replay.</span></h1>
<p style="margin:0;color:#c8d9e8;font-size:16px;line-height:1.65;">Your recording is ready. Watch the match again, share the moment, or save a copy.</p>
${content.notice ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:24px;"><tr><td style="padding:16px;background:#08233d;border-left:3px solid #f4c87a;color:#f5f9ff;font-size:14px;line-height:1.6;">${escapeHtml(content.notice)}</td></tr></table>` : ""}
<table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:28px;"><tr><td bgcolor="#0bd6c1" align="center" style="border-radius:12px;mso-padding-alt:16px 28px;"><a href="${url}" style="display:inline-block;padding:16px 28px;border:1px solid #0bd6c1;border-radius:12px;color:#032437;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:20px;font-weight:bold;text-decoration:none;">Watch your recording&nbsp; &#8594;</a></td></tr></table>
<p style="margin:12px 0 28px;color:#aebfd2;font-size:12px;line-height:1.5;">Watch or download from your replay page.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#08233d" style="border:1px solid #34526c;border-radius:12px;"><tr><td style="padding:20px;">
<p style="margin:0 0 8px;color:#0bd6c1;font-size:10px;line-height:1.5;letter-spacing:1.5px;font-weight:bold;text-transform:uppercase;">AVAILABLE UNTIL</p>
<p style="margin:0 0 4px;color:#f5f9ff;font-size:18px;line-height:1.4;font-weight:bold;">${escapeHtml(content.deadline)}</p>
<p style="margin:0 0 12px;color:#aebfd2;font-size:12px;line-height:1.5;">${escapeHtml(content.zone)}</p>
<p style="margin:0;color:#c8d9e8;font-size:13px;line-height:1.6;">Save a copy before this deadline. Your replay link expires then.</p>
</td></tr></table>
<p style="margin:22px 0 0;color:#aebfd2;font-size:12px;line-height:1.7;">${escapeHtml(content.accessNote)}</p>
<p style="margin:12px 0 0;font-size:12px;line-height:1.7;"><a href="${url}" style="color:#0bd6c1;text-decoration:underline;">Open replay in your browser</a></p>
</td></tr>
<tr><td class="email-pad" style="padding:22px 40px;border-top:1px solid #34526c;"><p style="margin:0 0 6px;color:#f5f9ff;font-size:13px;font-weight:bold;line-height:1.5;">Your court. Your moment.</p><p style="margin:0;color:#aebfd2;font-size:11px;line-height:1.5;">DinkVision &nbsp;&#183;&nbsp; Powered by WrenLabs</p></td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
}
