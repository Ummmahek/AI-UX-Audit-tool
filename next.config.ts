import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["cheerio"],
  // Vercel timeout for long-running image/validation requests
};

export default nextConfig;