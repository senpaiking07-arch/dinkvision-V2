import type { Metadata } from "next";
import { redirect } from "next/navigation";
import AdminEnrollmentQr from "@/components/admin-enrollment-qr";
import { getAccount } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Device enrollment · DinkVision",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function AdminEnrollmentPage() {
  const { account } = await getAccount();
  if (!account) redirect("/admin/login");
  if (account.role !== "admin") redirect("/");
  return <main className="auth-page"><AdminEnrollmentQr /></main>;
}
