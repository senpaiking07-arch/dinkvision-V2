import { guestReplay } from "@/lib/replay-server";
import { notFound } from "next/navigation";
import { Clock3, Download, LockKeyhole } from "lucide-react";
import ReplayVideo from "@/components/replay-video";
import { WebsiteHeader } from "@/components/website-frame";

export const dynamic="force-dynamic";
export const metadata={title:"DinkVision replay",robots:{index:false,follow:false},referrer:"no-referrer"};

export default async function ReplayPage({params}:{params:Promise<{token:string}>}) {
  const {token}=await params;
  const file=await guestReplay(token);
  if(!file) notFound();
  const media=`/api/replay/${encodeURIComponent(token)}`;
  const expires = new Intl.DateTimeFormat("en-PH", {
    dateStyle: "long", timeStyle: "short", timeZone: "Asia/Manila",
  }).format(new Date(file.expires_at));
  return <>
    <WebsiteHeader />
    <main className="shell website-main replay-page">
      <header className="website-page-heading">
        <div><h1>Your match replay</h1><p><LockKeyhole size={15} aria-hidden="true" /> Private replay link</p></div>
        <a className="primary" href={`${media}?download=1`}><Download size={17} aria-hidden="true" /> Download recording</a>
      </header>
      <ReplayVideo src={media} />
      <div className="website-notice replay-expiry">
        <Clock3 size={21} aria-hidden="true" />
        <div><strong>Available until <time dateTime={file.expires_at}>{expires}</time> (Manila time)</strong>
          <p>Download a copy before the link expires. Share the link only with people who should be able to watch.</p></div>
      </div>
    </main>
  </>;
}
