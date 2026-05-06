// universal crawler using playwright-extra + manual stealth
import { chromium } from 'playwright-extra';

// exported for other modules
export interface CrawlOptions {
  timeout?: number;
  handleCookieConsent?: boolean;
  maxRetries?: number;
}

export async function crawlWebsite(
  url: string,
  options: CrawlOptions = {}
): Promise<{
  bodyText: string;
  title: string;
  screenshots: Buffer[];
  blocked: boolean;
}> {
  const { timeout = 20000, handleCookieConsent = true, maxRetries = 2 } = options;
  // 'networkidle' avoided — analytics/polling prevents it from ever firing on many sites.
  const waitStrategies: Array<'domcontentloaded' | 'load'> = ['domcontentloaded', 'load'];
  let attempt = 0;

  while (attempt < maxRetries) {
    const waitUntil = waitStrategies[Math.min(attempt, waitStrategies.length - 1)];
    const attemptTimeout = attempt === 0 ? timeout : Math.round(timeout * 1.5);
    let browser;
    try {
      console.log(`[CRAWLER] attempt ${attempt + 1}/${maxRetries} – ${url} (waitUntil=${waitUntil}, timeout=${attemptTimeout}ms)`);
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
        ],
      });

      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: getRotatingUserAgent(),
        locale: 'en-US',
        timezoneId: 'America/New_York',
        acceptDownloads: false,
      });

      // manual stealth techniques
      await context.addInitScript(() => {
        // Override navigator.webdriver
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false
        });
        
        // Override plugins
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5]
        });
        
        // Override languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en']
        });
      });

      const page = await context.newPage();
      await page.setExtraHTTPHeaders({
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      });

      const response = await page.goto(url, { waitUntil, timeout: attemptTimeout });
      const status = response?.status();
      if (status && status >= 400) {
        console.warn(`[CRAWLER] HTTP ${status}`);
        if (status === 403 || status === 503) {
          throw new Error(`Access blocked: HTTP ${status}`);
        }
      }

      // small delay for dynamic content
      await page.waitForTimeout(3000);
      if (handleCookieConsent) {
        await dismissCookies(page);
      }

      const title = await page.title();
      const bodyText = (await page.textContent('body')) || '';

      if (detectBlocking(title, bodyText)) {
        console.warn('[CRAWLER] blocked content detected');
        throw new Error('Blocked or denied');
      }

      const shot = await page.screenshot({ fullPage: true });
      await browser.close();
      return { bodyText, title, screenshots: [shot], blocked: false };
    } catch (err: any) {
      console.error(`[CRAWLER] failed attempt ${attempt + 1}:`, err.message);
      if (browser) await browser.close();
      attempt++;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }
  }

  console.error('[CRAWLER] all attempts failed');
  return { bodyText: '', title: 'Access Denied', screenshots: [], blocked: true };
}

function getRotatingUserAgent(): string {
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}

function detectBlocking(title: string, body: string): boolean {
  const combined = (title + ' ' + body).toLowerCase();
  const indicators = [
    'access denied', 'blocked', 'captcha', 'robot', 'unusual traffic',
    'cloudflare', 'security check', 'please verify', 'human verification',
  ];
  return indicators.some((i) => combined.includes(i)) || body.length < 500;
}

async function dismissCookies(page: any) {
  const selectors = [
    'button:has-text("Accept")',
    'button:has-text("Accept All")',
    '#onetrust-accept-btn-handler',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click({ timeout: 2000 });
        await page.waitForTimeout(1000);
        return;
      }
    } catch {}
  }
}

export function shouldUsePlaywright(bodyText: string): boolean {
  const t = (bodyText ?? '').trim();
  if (t.length < 200) return true;
  const hasReal = /add to (bag|cart|wishlist)|checkout|aed|price|£|\$|€|product|delivery/i.test(t) &&
    t.split(/\s+/).length > 80;
  return !hasReal;
}

// convenience wrapper if you want to iterate over a list of URLs
export async function crawlMultiplePages(
  urls: string[],
  options: CrawlOptions = {}
): Promise<
  Array<{
    url: string;
    bodyText: string;
    title: string;
    screenshots: Buffer[];
    blocked: boolean;
  }>
> {
  const results = [];
  for (const url of urls) {
    const res = await crawlWebsite(url, options);
    results.push({ url, ...res });
    // small delay so we don't hammer servers
    await new Promise((r) => setTimeout(r, 2000));
  }
  return results;
}
