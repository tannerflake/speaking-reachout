import type { NextConfig } from "next";

// Allow next/image to load public site assets from Supabase Storage.
function supabaseImageHost(): string | undefined {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

const sbHost = supabaseImageHost();

const nextConfig: NextConfig = {
  // The Discover + outreach routes make long-running Claude (web search) calls.
  // Keep server actions generous so large lead batches don't get cut off.
  experimental: {
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
  images: {
    remotePatterns: [
      // Supabase Storage public bucket for site_images.
      ...(sbHost
        ? [{ protocol: "https" as const, hostname: sbHost, pathname: "/storage/v1/object/public/**" }]
        : []),
      // Fallback so production builds without the env var still allow Supabase.
      { protocol: "https" as const, hostname: "*.supabase.co", pathname: "/storage/v1/object/public/**" },
    ],
  },
};

export default nextConfig;
