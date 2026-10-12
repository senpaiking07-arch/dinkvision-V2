import type { Metadata } from "next";
import "./globals.css";
import "./admin.css";

export const metadata: Metadata = {
  title: "Wrenlabs Pickleball Camera | Your court. Your moment.",
  description:
    "Record your pickleball match at Wrenlabs Pickleball Camera and keep your favorite moments.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
