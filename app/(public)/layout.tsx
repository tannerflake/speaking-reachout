import type { Metadata } from "next";
import { Playfair_Display, Public_Sans } from "next/font/google";

// Classic high-contrast serif for headings; Public Sans (the U.S. government
// typeface) for body, for a refined, institutional feel.
const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-playfair",
  display: "swap",
});

const publicSans = Public_Sans({
  subsets: ["latin"],
  variable: "--font-public-sans",
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
    <div className={`public-site ${playfair.variable} ${publicSans.variable}`}>
      {children}
    </div>
  );
}
