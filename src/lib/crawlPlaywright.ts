// @ts-ignore: missing playwright types in this workspace
import { chromium } from 'playwright';
import type { CrawlResult, CrawledPage } from './crawl'; // import existing types exactly
import { runDomChecks } from './crawl'; // import the function added in Change 2

/**
 * Playwright-based crawler. Returns the same CrawlResult shape as crawl.ts.
 * Use for JS-rendered sites where the cheerio crawler returns thin content.
 * crawl.ts remains unchanged and is the default — this is the escalation path.
 */
export async function crawlWithPlaywright(startUrl: string): Promise<CrawlResult> {
  // Playwright requires downloaded browser binaries. If those are missing you'll
  // get an error like "Executable doesn't exist at ...". That usually means the
  // project was just cloned/installed and the `npx playwright install` step
  // hasn't been run yet. Surface a clearer log message so the developer knows
  // what to do (route.ts already catches the error and falls back to cheerio).
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    console.error(
      '[PLAYWRIGHT] failed to launch chromium – have you run `npx playwright install`?\n',
      err
    );
    // re‑throw so the caller (api route) can continue gracefully
    throw err;
  }
  const pages: CrawledPage[] = [];

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const urlsToVisit = await resolveKeyPaths(startUrl, context);

    for (const { url, label } of urlsToVisit) {
      // label may be a generic string; cast to CrawlPageLabel when pushing
      try {
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

        // Extract same fields as cheerio crawler
        const title = await page.title().catch(() => '');
        const metaDescription = await page
          .$eval('meta[name="description"]', (el: any) => el.getAttribute('content') ?? '')
          .catch(() => '');
        const h1 = await page.$eval('h1', (el: any) => el.textContent?.trim() ?? '').catch(() => '');
        const headings = await page.$$eval('h2, h3', (els: any[]) =>
          els.map((el: any) => ({ tag: el.tagName.toLowerCase(), text: el.textContent?.trim() ?? '' }))
        ).catch(() => []);
        const buttons = await page.$$eval('button, [role="button"]', (els: any[]) =>
          els.map((el: any) => el.textContent?.trim() ?? el.getAttribute('aria-label') ?? '').filter(Boolean)
        ).catch(() => []);
        const forms = await page.$$eval('input:not([type="hidden"])', (els: any[]) =>
          els.map((el: any) => ({
            type: el.getAttribute('type') ?? 'text',
            placeholder: el.getAttribute('placeholder') ?? '',
            ariaLabel: el.getAttribute('aria-label') ?? '',
          }))
        ).catch(() => []);
        const bodyText = await page
          .$eval('body', (el: any) => el.innerText?.slice(0, 1400) ?? '')
          .catch(() => '');

        // Computed styles — only available via Playwright (not cheerio)
        const computedStyles = await page.evaluate(() => {
          const hasFocusStyleSuppressed = Array.from(document.querySelectorAll('*')).some((el) => {
            const s = window.getComputedStyle(el);
            return s.outlineStyle === 'none' && s.outlineWidth === '0px';
          });
          const overlayDetected = Array.from(document.querySelectorAll('*')).some((el) => {
            const s = window.getComputedStyle(el);
            const zIndex = parseInt(s.zIndex, 10);
            const opacity = parseFloat(s.opacity);
            return (s.position === 'fixed' || s.position === 'absolute') && zIndex > 100 && opacity < 0.85;
          });
          const bodyStyle = window.getComputedStyle(document.body);
          return {
            hasFocusStyleSuppressed,
            overlayDetected,
            bodyBackgroundColor: bodyStyle.backgroundColor,
            bodyFontColor: bodyStyle.color,
          };
        }).catch(() => null);

        // Re-use the DOM check logic via the page's HTML
        const html = await page.content().catch(() => '');
        const cheerio = await import('cheerio');
        const $ = cheerio.load(html);
        const domChecks = runDomChecks(html, $, title, metaDescription);

        // capture a screenshot of the full page and store as data URL
        let screenshot: string | undefined;
        try {
          const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: true });
          screenshot = `data:image/jpeg;base64,${buf.toString('base64')}`;
        } catch (e) {
          console.warn('[PLAYWRIGHT] screenshot failed for', url, e);
        }

        pages.push({
          url,
          label: label as any,
          title,
          metaDescription,
          h1,
          headings,
          buttons,
          forms,
          bodyText,
          domChecks,
          computedStyles: computedStyles ?? undefined,
          screenshot,
        } as any);

        await page.close();
      } catch {
        // Skip page on error — same graceful degradation as crawl.ts
        continue;
      }
    }
  } finally {
    await browser.close();
  }

  return { pages, targetUrl: startUrl, blockedOrLimited: false };
}

/**
 * Heuristic path resolver — same logic as crawl.ts link-picking.
 * Identifies Home, Category, Product, Cart, Checkout URLs from homepage links.
 */
async function resolveKeyPaths(
  startUrl: string,
  context: any
) {
  const targets: Array<{ url: string; label: string }> = [
    { url: startUrl, label: 'homepage' },
  ];

  try {
    const page = await context.newPage();
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const links = await page.$$eval('a[href]', (els: any[]) =>
      els.map((el: any) => el.getAttribute('href') ?? '').filter(Boolean)
    );
    await page.close();

    const base = new URL(startUrl);
    const resolve = (href: string) => {
      try { return new URL(href, base).href; } catch { return null; }
    };

    const patterns: Array<{ label: string; regex: RegExp }> = [
      { label: 'category', regex: /\/(category|collection|shop|browse|c\/)\//i },
      { label: 'product', regex: /\/(product|p\/|item|detail)/i },
      { label: 'cart', regex: /\/(cart|basket|bag)\b/i },
      { label: 'checkout', regex: /\/(checkout|order|payment)\b/i },
    ];

    for (const { label, regex } of patterns) {
      const match = links.find((l: any) => regex.test(l));
      if (match) {
        const resolved = resolve(match);
        if (resolved) targets.push({ url: resolved, label });
      }
    }
  } catch {
    // If homepage link resolution fails, return just the homepage
  }

  return targets;
}

/**
 * Helper the API route can call to decide whether to use Playwright.
 * If cheerio returned thin content (< 200 chars), the page is likely JS-rendered.
 */
export function shouldUsePlaywright(cheerioBodyText: string): boolean {
  const text = (cheerioBodyText ?? '').trim();
  // Always escalate if content is very thin
  if (text.length < 200) return true;
  // Escalate if static shell has text but lacks real commerce content signals
  // (indicates JS-rendered app — cheerio got the shell, not the page)
  const hasRealContent =
    /add to (bag|cart|wishlist)|checkout|aed|price|£|\$|€|product|delivery/i.test(text) &&
    text.split(/\s+/).length > 80;
  return !hasRealContent;
}
