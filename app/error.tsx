"use client";
import { WebsiteMessage } from "@/components/website-frame";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <WebsiteMessage title="DinkVision could not load">
      <p>Try loading this page again or return to Admin.</p>
      <div className="website-actions">
        <button className="primary" onClick={reset}>Try again</button>
        <a className="sign-in" href="/admin">Go to Admin</a>
      </div>
    </WebsiteMessage>
  );
}
