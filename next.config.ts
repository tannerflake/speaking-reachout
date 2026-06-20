import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Discover + outreach routes make long-running Claude (web search) calls.
  // Keep server actions generous so large lead batches don't get cut off.
  experimental: {
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
};

export default nextConfig;
