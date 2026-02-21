import * as cheerio from "cheerio";
import dns from "dns/promises";
import net from "net";

export type CrawlPageLabel = "home" | "category" | "product" | "cart" | "checkout";

export type CrawledPage = {
  label: CrawlPageLabel;
  requestedUrl: string;
  finalUrl?: string;
  status?: number;
  blockedByBotProtection?: boolean;
  error?: string;
  excerpt?: string;
};

export type CrawlResult = {
  targetUrl: string;
  blockedOrLimited: boolean;
  note?: string;
  pages: CrawledPage[];
};

const MAX_HTML_BYTES = 1_000_000; // 1MB per page (keeps it safe + fast)
const FETCH_TIMEOUT_MS = 12_000;
const MAX_PAGES = 5; // home + 4 key paths

function isPrivateIp(ip: string): boolean {
  // IPv4
  if (net.isIP(ip) === 4) {
    const parts = ip.split(".").map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  // IPv6 (coarse checks)
  if (net.isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1") return true;
    if (v.startsWith("fe80:")) return true; // link-local
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique local (fc00::/7)
    return false;
  }

  return true;
}

async function assertPublicHostname(hostname: string): Promise<void> {
  const lower = hostname.toLowerCase().trim();
  if (!lower) throw new Error("Missing hostname");
  if (lower === "localhost" || lower.endsWith(".local")) {
    throw new Error("Blocked hostname");
  }

  // If it's already an IP, validate directly.
  if (net.isIP(lower)) {
    if (isPrivateIp(lower)) throw new Error("Blocked private IP");
    return;
  }

  // Resolve DNS and block private ranges to prevent SSRF.
  const results = await dns.lookup(lower, { all: true, verbatim: true });
  if (!results.length) throw new Error("DNS lookup failed");
  for (const r of results) {
    if (isPrivateIp(r.address)) throw new Error("Blocked private IP");
  }
}

function normalizeTargetUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    // Allow bare domains (e.g. example.com)
    url = new URL(`https://${input}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http/https URLs are allowed");
  }
  url.hash = "";
  return url;
}

function detectBotProtection(status: number, headers: Headers, html: string): boolean {
  if ([403, 429, 503].includes(status)) {
    const server = (headers.get("server") ?? "").toLowerCase();
    const via = (headers.get("via") ?? "").toLowerCase();
    const ray = headers.get("cf-ray");
    const body = html.toLowerCase();
    if (server.includes("cloudflare") || via.includes("cloudflare") || Boolean(ray)) return true;
    if (
      body.includes("attention required") ||
      body.includes("cf-chl") ||
      body.includes("cf-error") ||
      body.includes("cloudflare") ||
      body.includes("checking your browser")
    ) {
      return true;
    }
  }
  return false;
}

async function fetchHtmlSafe(requestUrl: URL, expectedHostname: string): Promise<{
  finalUrl: string;
  status: number;
  blockedByBotProtection: boolean;
  html: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(requestUrl.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // Keep this generic; some WAFs block empty UA
        "user-agent":
          "Mozilla/5.0 (compatible; UXAuditBot/1.0; +https://example.com/bot)",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });

    const finalUrl = res.url || requestUrl.toString();
    const final = new URL(finalUrl);
    final.hash = "";

    // Prevent redirect-based SSRF to a different host.
    if (final.hostname !== expectedHostname) {
      throw new Error("Redirected to a different hostname (blocked)");
    }

    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.includes("text/html") && !ct.includes("application/xhtml+xml")) {
      throw new Error(`Non-HTML content-type: ${ct || "unknown"}`);
    }

    // Read with a hard cap.
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_HTML_BYTES) {
        throw new Error("HTML too large (blocked by limit)");
      }
      chunks.push(value);
    }
    const html = Buffer.concat(chunks).toString("utf-8");
    const blockedByBotProtection = detectBotProtection(res.status, res.headers, html);
    return { finalUrl: final.toString(), status: res.status, blockedByBotProtection, html };
  } finally {
    clearTimeout(timeout);
  }
}

function textSlice(input: string, maxChars: number): string {
  const s = input.replace(/\s+/g, " ").trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars - 1)}…`;
}

function extractPageExcerpt(html: string, pageUrl: string): { excerpt: string; links: string[] } {
  const $ = cheerio.load(html);
  $("script,style,noscript").remove();

  const title = $("title").first().text().trim();
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ?? "";

  const h1 = $("h1").first().text().trim();
  const headings = $("h2,h3")
    .slice(0, 12)
    .toArray()
    .map((el) => $(el).text().trim())
    .filter(Boolean);

  const buttons = $("button, [role='button'], a")
    .slice(0, 30)
    .toArray()
    .map((el) => $(el).text().trim())
    .filter((t) => t.length >= 2 && t.length <= 60);

  const forms = $("input, select, textarea")
    .slice(0, 30)
    .toArray()
    .map((el) => {
      const placeholder = $(el).attr("placeholder")?.trim() ?? "";
      const name = $(el).attr("name")?.trim() ?? "";
      const type = $(el).attr("type")?.trim() ?? "";
      const aria = $(el).attr("aria-label")?.trim() ?? "";
      const label =
        $(el).closest("label").text().trim() ||
        $(`label[for="${$(el).attr("id") ?? ""}"]`).text().trim();
      const best = label || aria || placeholder || name || type;
      return best.trim();
    })
    .filter(Boolean);

  const bodyText = $("main").text().trim() || $("body").text().trim();
  const bodySnippet = textSlice(bodyText, 1400);

  const linkHrefs = $("a[href]")
    .slice(0, 300)
    .toArray()
    .map((el) => $(el).attr("href") ?? "")
    .filter(Boolean);

  const base = new URL(pageUrl);
  const links = linkHrefs
    .map((href) => {
      try {
        const u = new URL(href, base);
        u.hash = "";
        return u;
      } catch {
        return null;
      }
    })
    .filter((u): u is URL => Boolean(u))
    .filter((u) => u.origin === base.origin)
    .map((u) => u.toString());

  const excerptLines = [
    `URL: ${pageUrl}`,
    title ? `Title: ${textSlice(title, 160)}` : "",
    metaDescription ? `Meta: ${textSlice(metaDescription, 220)}` : "",
    h1 ? `H1: ${textSlice(h1, 160)}` : "",
    headings.length ? `Headings: ${headings.map((h) => textSlice(h, 90)).join(" | ")}` : "",
    buttons.length ? `Buttons/links (sample): ${buttons.slice(0, 16).join(" | ")}` : "",
    forms.length ? `Form fields (sample): ${forms.slice(0, 16).join(" | ")}` : "",
    bodySnippet ? `Visible text (snippet): ${bodySnippet}` : "",
  ].filter(Boolean);

  return { excerpt: excerptLines.join("\n"), links };
}

function pickBestLink(links: string[], patterns: RegExp[]): string | null {
  for (const pat of patterns) {
    const found = links.find((l) => pat.test(l));
    if (found) return found;
  }
  return links[0] ?? null;
}

function isContentLikePath(u: string): boolean {
  try {
    const url = new URL(u);
    const p = url.pathname.toLowerCase();
    // Blog/editorial/documentation paths that often masquerade as “category”
    // e.g. /blog/category/foo should NOT be treated as a PLP category.
    return (
      p.startsWith("/blog") ||
      p.includes("/blog/") ||
      p.startsWith("/blogs") ||
      p.includes("/blogs/") ||
      p.includes("/news/") ||
      p.includes("/article") ||
      p.includes("/posts") ||
      p.includes("/post/") ||
      p.includes("/tag/") ||
      p.includes("/author/") ||
      p.includes("/wp-")
    );
  } catch {
    return true;
  }
}

function preferNonContentLinks(links: string[]): string[] {
  const nonContent = links.filter((l) => !isContentLikePath(l));
  return nonContent.length ? nonContent : links;
}

export async function crawlKeyPaths(target: string): Promise<CrawlResult> {
  const targetUrl = normalizeTargetUrl(target);
  await assertPublicHostname(targetUrl.hostname);

  const pages: CrawledPage[] = [];

  // 1) Home
  const home: CrawledPage = { label: "home", requestedUrl: targetUrl.toString() };
  pages.push(home);

  let homeLinks: string[] = [];
  let blockedOrLimited = false;

  try {
    const fetched = await fetchHtmlSafe(targetUrl, targetUrl.hostname);
    home.finalUrl = fetched.finalUrl;
    home.status = fetched.status;
    home.blockedByBotProtection = fetched.blockedByBotProtection;
    if (fetched.blockedByBotProtection) blockedOrLimited = true;
    const extracted = extractPageExcerpt(fetched.html, fetched.finalUrl);
    home.excerpt = extracted.excerpt;
    homeLinks = extracted.links;
  } catch (e) {
    blockedOrLimited = true;
    home.error = e instanceof Error ? e.message : "Unknown crawl error";
  }

  // If homepage is blocked, stop early and let the caller fall back gracefully.
  if (!homeLinks.length) {
    return {
      targetUrl: targetUrl.toString(),
      blockedOrLimited,
      note: blockedOrLimited
        ? "Crawl was blocked/limited (often due to bot protection), using URL + screenshots + issue library only."
        : "No internal links discovered on homepage.",
      pages,
    };
  }

  // 2) Pick key pages from internal links (heuristics)
  const candidateLinks = preferNonContentLinks(homeLinks);

  const categoryUrl = pickBestLink(candidateLinks, [
    /\/collections\b/i,
    /\/category\b/i,
    /\/categories\b/i,
    /\/shop\b/i,
    /\/store\b/i,
    /\/products\b/i,
    /\/catalog\b/i,
  ]);

  const productUrl = pickBestLink(candidateLinks, [
    /\/product\b/i,
    /\/products\/[^/]+/i,
    /\/p\/[^/]+/i,
    /\/item\/[^/]+/i,
  ]);

  const cartUrl = pickBestLink(candidateLinks, [/\/cart\b/i, /\/bag\b/i, /\/basket\b/i]);
  const checkoutUrl = pickBestLink(candidateLinks, [/\/checkout\b/i, /\/payment\b/i]);

  const chosen: Array<{ label: CrawlPageLabel; url: string | null }> = [
    { label: "category", url: categoryUrl },
    { label: "product", url: productUrl },
    { label: "cart", url: cartUrl },
    { label: "checkout", url: checkoutUrl },
  ].filter((x) => Boolean(x.url)) as Array<{ label: CrawlPageLabel; url: string }>;

  for (const item of chosen.slice(0, MAX_PAGES - 1)) {
    const page: CrawledPage = { label: item.label, requestedUrl: item.url };
    pages.push(page);
    try {
      const u = new URL(item.url);
      // Same-host enforced for safety (also blocks redirect-based SSRF inside fetchHtmlSafe)
      if (u.hostname !== targetUrl.hostname) {
        page.error = "Cross-host link skipped (safety)";
        blockedOrLimited = true;
        continue;
      }
      const fetched = await fetchHtmlSafe(u, targetUrl.hostname);
      page.finalUrl = fetched.finalUrl;
      page.status = fetched.status;
      page.blockedByBotProtection = fetched.blockedByBotProtection;
      if (fetched.blockedByBotProtection) blockedOrLimited = true;
      const extracted = extractPageExcerpt(fetched.html, fetched.finalUrl);
      page.excerpt = extracted.excerpt;
    } catch (e) {
      blockedOrLimited = true;
      page.error = e instanceof Error ? e.message : "Unknown crawl error";
    }
  }

  return {
    targetUrl: targetUrl.toString(),
    blockedOrLimited,
    note: blockedOrLimited
      ? "Crawl partially blocked/limited (commonly Cloudflare/WAF, timeouts, or non-HTML responses). Use findings as partial evidence only."
      : "Crawl succeeded for key paths.",
    pages,
  };
}

