import type { Metadata } from "next";
import { redirect } from "next/navigation";
import AdminEnrollmentQr from "@/components/admin-enrollment-qr";
import AdminHeader from "@/components/admin-header";
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
  return <>
    <AdminHeader account={account} back />
    <main className="shell admin-main"><AdminEnrollmentQr /></main>
  </>;
}
