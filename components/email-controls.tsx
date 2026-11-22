"use client";
import {useEffect,useState} from "react";
type MailStatus={smtp?:{ready:boolean;configured:boolean;from?:string};files:{id:string;session_id:string;recording_sessions:{recipient_email:string;configuration_snapshot?:{recipient_emails?:string[]}}}[];jobs:{file_id:string;status:string;attempts:number;safe_error:string|null;sent_at:string|null;next_attempt_at:string}[]};
export default function EmailControls() {
  const [data,setData]=useState<MailStatus>(),[busy,setBusy]=useState("");
  async function load(){const r=await fetch("/api/admin/email",{cache:"no-store"});const v=await r.json();if(r.ok)setData(v);}
  useEffect(()=>{load();},[]);
  async function queue(fileId:string) {
    setBusy(fileId);
    const r=await fetch("/api/admin/email",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({file_id:fileId})});
    setBusy(""); if(r.ok) await load(); else alert((await r.json()).error||"Could not send email.");
  }
  const jobs=Object.fromEntries((data?.jobs||[]).map(j=>[j.file_id,j]));
  return <section className="admin-card storage-integration-card">
    <div className="eyebrow">EMAIL DELIVERY</div><h2>Recording replay emails</h2>
    <p>{data?.smtp?.ready?`SMTP email is ready${data.smtp.from?` as ${data.smtp.from}`:""}. New browser uploads are emailed by the cloud worker.`:data?.smtp?.configured?"SMTP is configured but currently unavailable. Check server SMTP settings.":"SMTP email is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, and SMTP_FROM on the server."}</p>
    <p className="form-note">Emails contain a playback link, not a video attachment. Anyone holding a guest replay link can watch. Sent means SMTP accepted the message; it does not confirm inbox delivery. Check spam if needed. Previous uploads need an explicit Send email action.</p>
    <ul className="activity-list">
      {(data?.files||[]).map(file=>{
        const job=jobs[file.id],recipients=(file.recording_sessions.configuration_snapshot?.recipient_emails as string[]|undefined)||[file.recording_sessions.recipient_email];
        return <li key={file.id}><div>
          <strong>{file.session_id.slice(0,8)}</strong>
          <p className="form-note">{recipients.join(", ")} ? {job?`${job.status}${job.safe_error?` (${job.safe_error})`:""}`:"not queued"}</p>
        </div><div>
          {(!job || job.status==="failed") && <button className="sign-in" disabled={busy===file.id || !data?.smtp?.ready} onClick={()=>queue(file.id)}>{job?"Retry email":"Send email"}</button>}
          {job?.status==="sent" && <span className="status-tag connected">Sent {job.sent_at?new Date(job.sent_at).toLocaleString():""}</span>}
          {job && ["pending","sending","unknown"].includes(job.status) && <span className="status-tag">{job.status}</span>}
        </div></li>;
      })}
    </ul>
  </section>;
}
