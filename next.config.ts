import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "cheerio",
    "playwright",
    "playwright-core",
    "playwright-extra",
    "puppeteer-extra-plugin-stealth"
  ],
  outputFileTracingIncludes: {
    '/api/**/*': [
      './node_modules/**/puppeteer-extra-plugin-stealth/**/*',
      './node_modules/**/puppeteer-extra-plugin/**/*',
      './node_modules/**/merge-deep/**/*',
      './node_modules/**/clone-deep/**/*',
      './node_modules/**/is-plain-object/**/*',
      './node_modules/**/isobject/**/*'
    ]
  }
};

export default nextConfig;