import { WebsiteMessage } from "@/components/website-frame";

export default function ReplayUnavailable() {
  return <WebsiteMessage title="Replay unavailable">
    <p>This private link is invalid, expired, or the recording has been removed.</p>
    <p>Contact the venue if you need help finding your recording.</p>
  </WebsiteMessage>;
}
