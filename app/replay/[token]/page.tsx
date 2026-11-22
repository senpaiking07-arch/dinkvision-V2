import { guestReplay } from "@/lib/replay-server";
import { notFound } from "next/navigation";

export const dynamic="force-dynamic";
export const metadata={title:"DinkVision replay",robots:{index:false,follow:false},referrer:"no-referrer"};

export default async function ReplayPage({params}:{params:Promise<{token:string}>}) {
  const {token}=await params;
  const file=await guestReplay(token);
  if(!file) notFound();
  const media=`/api/replay/${encodeURIComponent(token)}`;
  return <main className="page-shell"><section className="admin-card">
    <p className="eyebrow">DinkVision</p><h1>Your match replay</h1>
    <video controls playsInline preload="metadata" src={media} style={{width:"100%",maxHeight:"75vh",background:"#111"}} />
    <p><a className="primary" href={`${media}?download=1`}>Download recording</a></p>
    <p>This private link works until {new Date(file.expires_at).toLocaleString("en-PH",{timeZone:"Asia/Manila"})} (Asia/Manila). Save a copy before then.</p>
    <p>Only share this link with people who should be able to watch.</p>
  </section></main>;
}
