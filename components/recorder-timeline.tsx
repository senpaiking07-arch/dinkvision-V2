"use client";
import { useEffect, useRef, useState } from "react";
import { codeLabel, stageLabel, type RecorderEvent } from "@/lib/recorder-events";
import { AdminSkeleton, SkeletonRows } from "@/components/admin-skeleton";

export function RecorderTimeline({sessionId,deviceId}:{sessionId?:string;deviceId?:string}) {
  const [events,setEvents]=useState<(RecorderEvent&{received_at:string})[]>([]);
  const [state,setState]=useState<"idle"|"loading"|"loaded"|"error"|"disabled">("idle");
  const pending=useRef<AbortController|null>(null);
  useEffect(()=>()=>{pending.current?.abort();},[]);
  async function load() {
    if(pending.current)return;
    const controller=new AbortController();pending.current=controller;
    const timeout=setTimeout(()=>controller.abort(),10000);
    setState("loading");
    try {
      const response=await fetch("/api/admin/recorder-diagnostics?"+new URLSearchParams(
        sessionId?{session:sessionId}:{device:deviceId||""}),{cache:"no-store",signal:controller.signal});
      if(!response.ok)throw Error();
      const body=await response.json();
      setEvents(body.events||[]);setState(body.enabled?"loaded":"disabled");
    } catch {setState("error");}
    finally {clearTimeout(timeout);pending.current=null;}
  }
  return <details onClick={event=>event.stopPropagation()} onToggle={event=>{
    if(event.currentTarget.open && state==="idle")void load();
  }}>
    <summary>Recording diagnostics</summary>
    <p>Measured device stages and reported failures. Request timings include the network and server; they do not establish Wi-Fi speed or a hardware fault.</p>
    {state==="loading"&&<AdminSkeleton label="Loading diagnostic history"><SkeletonRows count={2} /></AdminSkeleton>}
    {state==="disabled"&&<p>Diagnostics are not enabled on this deployment yet.</p>}
    {state==="error"&&<p role="alert">Could not load diagnostics. Try again.</p>}
    {state==="loaded"&&!events.length&&<p>No diagnostic events reported. Older APKs cannot supply this history.</p>}
    {state==="loaded"&&<ol style={{paddingInlineStart:"1.2rem",maxHeight:"28rem",overflowY:"auto"}}>
      {[...events].sort((a,b)=>a.attempt_id===b.attempt_id?a.elapsed_ms-b.elapsed_ms
        : Date.parse(a.occurred_at)-Date.parse(b.occurred_at)).map(e=><li key={e.event_id} style={{borderBottom:"1px solid var(--border, #d8dfd4)",paddingBlock:".65rem"}}>
        <strong>{stageLabel(e.stage)}</strong> · {(e.duration_ms/1000).toFixed(2)} s · {e.result}
        <br/><small>{e.stage === "start_accepted" && `${e.elapsed_ms} ms after Start · `}{new Date(e.occurred_at).toLocaleString()} · {e.operation} · Queue: {e.queue_count} · Attempt retry: {e.retry_count} · APK build {e.version_code}</small>
        {e.bytes>0&&<p>{(e.bytes/1048576).toFixed(1)} MB</p>}
        {e.acknowledged_bytes != null && <p>{(e.acknowledged_bytes / 1048576).toFixed(1)} MB confirmed in cloud storage</p>}
        {e.transferred_bytes != null && e.transferred_bytes > 0 && e.duration_ms > 0 &&
          <p>{(e.transferred_bytes * 8 / e.duration_ms / 1000).toFixed(2)} Mbps during this transfer stage</p>}
        {e.action_source && <p>Source: {e.action_source === "player" ? "Player screen" : e.action_source === "admin" ? "Admin" : "Android notification"}</p>}
        {e.repeated_actions != null && <p>{e.repeated_actions} repeated {e.repeated_actions === 1 ? "press" : "presses"} ignored</p>}
        {e.http_status != null && <p>HTTP {e.http_status}</p>}
        {e.retry_delay_ms != null && <p>Retry scheduled in {Math.ceil(e.retry_delay_ms / 1000)} s</p>}
        {e.code!=="none"&&<p>{codeLabel(e.code)}</p>}
        <details><summary>Trace identifiers</summary>
          <small style={{overflowWrap:"anywhere"}}>Attempt: {e.attempt_id}<br/>Recording: {e.session_id||"Not assigned yet"}<br/>Received: {new Date(e.received_at).toLocaleString()}</small>
        </details>
      </li>)}
    </ol>}
    {state!=="idle"&&state!=="disabled"&&<button type="button" className="button secondary" disabled={state==="loading"} onClick={()=>void load()}>Refresh diagnostics</button>}
  </details>;
}
