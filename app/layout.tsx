import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Speaker Outreach CRM",
  description: "Generate, send, and track speaking-engagement outreach.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
