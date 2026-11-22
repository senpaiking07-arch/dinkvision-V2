import type { Metadata } from "next";
import TabletQrEnrollment from "@/components/tablet-qr-enrollment";
import { legacyEnrollmentCode } from "@/lib/tablet-enrollment";
import { WebsiteMessage } from "@/components/website-frame";
import "../../admin.css";

export const metadata: Metadata = {
  title: "Enroll tablet · DinkVision",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function EnrollmentPage({ searchParams }: {
  searchParams: Promise<{ invite?: string | string[] }>;
}) {
  const { invite } = await searchParams;
  return (
    <WebsiteMessage title="Pair this tablet">
        <TabletQrEnrollment invite={typeof invite === "string" && legacyEnrollmentCode.test(invite) ? invite : ""} />
    </WebsiteMessage>
  );
}
