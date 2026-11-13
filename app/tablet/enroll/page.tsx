import type { Metadata } from "next";
import TabletQrEnrollment from "@/components/tablet-qr-enrollment";
import { legacyEnrollmentCode } from "@/lib/tablet-enrollment";
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
    <main className="shell admin-main">
      <section className="confirm-modal">
        <h1>Enroll this tablet</h1>
        <TabletQrEnrollment invite={typeof invite === "string" && legacyEnrollmentCode.test(invite) ? invite : ""} />
      </section>
    </main>
  );
}
