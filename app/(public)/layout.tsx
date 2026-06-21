import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
  axes: ["opsz"],
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://jeffflake.com";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Book Ambassador Jeff Flake",
    template: "%s | Jeff Flake",
  },
  description:
    "Senator. Ambassador. Author. Book Ambassador Jeff Flake to speak: a voice that challenges without polarizing.",
  openGraph: {
    title: "Book Ambassador Jeff Flake",
    description:
      "Senator. Ambassador. Author. A voice that challenges without polarizing.",
    type: "website",
    url: SITE_URL,
  },
  twitter: { card: "summary_large_image" },
};

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className={`public-site ${fraunces.variable} ${inter.variable}`}>
      {children}
    </div>
  );
}
