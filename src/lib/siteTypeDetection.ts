/**
 * siteTypeDetection.ts — Domain-first, crawl-assisted site type classifier
 *
 * Layer 0: Known-domain registry  (instant, zero-crawl)
 * Layer 1: Domain-name scoring    (regex signals on root domain tokens)
 * Layer 2: URL structural signals  (path keywords, subdomain)
 * Layer 3: Enrichment scoring     (robots, sitemap, manifest, snippets)
 * Layer 4: Schema.org / JSON-LD   (structured data in HTML)
 * Layer 5: Meta tag scoring        (title + description)
 * Layer 6: HTML content scoring    (body text patterns)
 * Layer 7: Safe fallback           ('unknown' — never force a wrong type)
 */
import { parse as parseTld } from 'tldts';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SearchResult = {
  title: string;
  snippet: string;
  url?: string;
};

export type SiteType =
  | 'ecommerce'
  | 'marketplace'
  | 'saas'
  | 'real_estate'
  | 'agency'
  | 'cms'
  | 'finance'
  | 'corporate'
  | 'unknown';

export type DetectionResult = {
  type: SiteType;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
  scores: Record<SiteType, number>;
  layer: string;
  // Extended diagnostics
  sourceLayers: Array<'registry' | 'domain' | 'url' | 'meta' | 'schema' | 'enrichment' | 'html' | 'fallback'>;
  blocked: boolean;
  normalizedDomain: string;
  hostname: string;
  source?: 'rules' | 'duckduckgo_fallback';
  updatedAt?: number;
};

export type CachedDetectionResult = DetectionResult & {
  source: 'rules' | 'duckduckgo_fallback';
  updatedAt: number;
};

type Scores = Record<SiteType, number>;

/** Optional enrichment data that route.ts can fetch and pass in */
export type DetectionEnrichment = {
  robotsText?: string;
  sitemapText?: string;
  manifestText?: string;
  headers?: Record<string, string>;
  redirectUrls?: string[];
  searchTitle?: string;
  searchSnippet?: string;
  searchResults?: SearchResult[];
};

// ─── Layer 1: Known-domain registry ──────────────────────────────────────────
// Maps root domain → SiteType. This fires BEFORE any crawl attempt.
// Extend this list freely — it costs nothing and is always accurate.

const KNOWN_DOMAINS: Record<string, SiteType> = {
  // ── Ecommerce ──
  'amazon.com': 'ecommerce',
  'amazon.in': 'ecommerce',
  'amazon.co.uk': 'ecommerce',
  'amazon.de': 'ecommerce',
  'amazon.fr': 'ecommerce',
  'amazon.co.jp': 'ecommerce',
  'flipkart.com': 'ecommerce',
  'myntra.com': 'ecommerce',
  'ajio.com': 'ecommerce',
  'nykaa.com': 'ecommerce',
  'meesho.com': 'ecommerce',
  'shopify.com': 'ecommerce',
  'etsy.com': 'ecommerce',
  'ebay.com': 'ecommerce',
  'walmart.com': 'ecommerce',
  'target.com': 'ecommerce',
  'bestbuy.com': 'ecommerce',
  'zappos.com': 'ecommerce',
  'asos.com': 'ecommerce',
  'zara.com': 'ecommerce',
  'hm.com': 'ecommerce',
  'nike.com': 'ecommerce',
  'adidas.com': 'ecommerce',
  'ikea.com': 'ecommerce',
  'wayfair.com': 'ecommerce',
  'chewy.com': 'ecommerce',
  'overstock.com': 'ecommerce',
  'newegg.com': 'ecommerce',
  'adorama.com': 'ecommerce',
  'bhphotovideo.com': 'ecommerce',
  'snapdeal.com': 'ecommerce',
  'paytmmall.com': 'ecommerce',

  // ── Marketplace ──
  'indiamart.com': 'marketplace',
  'alibaba.com': 'marketplace',
  'aliexpress.com': 'marketplace',
  'olx.in': 'marketplace',
  'olx.com': 'marketplace',
  'quikr.com': 'marketplace',
  'craigslist.org': 'marketplace',
  'fiverr.com': 'marketplace',
  'upwork.com': 'marketplace',
  'freelancer.com': 'marketplace',
  'tradeindia.com': 'marketplace',

  // ── Finance ──
  'paypal.com': 'finance',
  'stripe.com': 'finance',
  'razorpay.com': 'finance',
  'paytm.com': 'finance',
  'phonepe.com': 'finance',
  'gpay.com': 'finance',
  'wise.com': 'finance',
  'revolut.com': 'finance',
  'robinhood.com': 'finance',
  'zerodha.com': 'finance',
  'groww.in': 'finance',
  'coinbase.com': 'finance',
  'binance.com': 'finance',
  'wazirx.com': 'finance',
  'hdfc.com': 'finance',
  'hdfcbank.com': 'finance',
  'icicibank.com': 'finance',
  'sbi.co.in': 'finance',
  'axisbank.com': 'finance',
  'kotak.com': 'finance',
  'chase.com': 'finance',
  'bankofamerica.com': 'finance',
  'wellsfargo.com': 'finance',
  'fidelity.com': 'finance',
  'schwab.com': 'finance',
  'vanguard.com': 'finance',
  'nerdwallet.com': 'finance',
  'creditkarma.com': 'finance',
  'cleartax.in': 'finance',

  // ── SaaS ──
  'salesforce.com': 'saas',
  'hubspot.com': 'saas',
  'notion.so': 'saas',
  'slack.com': 'saas',
  'figma.com': 'saas',
  'linear.app': 'saas',
  'jira.atlassian.com': 'saas',
  'atlassian.com': 'saas',
  'zendesk.com': 'saas',
  'intercom.com': 'saas',
  'mailchimp.com': 'saas',
  'airtable.com': 'saas',
  'asana.com': 'saas',
  'monday.com': 'saas',
  'clickup.com': 'saas',
  'freshdesk.com': 'saas',
  'zoom.us': 'saas',
  'webex.com': 'saas',
  'miro.com': 'saas',
  'loom.com': 'saas',
  'dropbox.com': 'saas',
  'box.com': 'saas',
  'docusign.com': 'saas',
  'calendly.com': 'saas',
  'typeform.com': 'saas',
  'surveymonkey.com': 'saas',
  'sendgrid.com': 'saas',
  'twilio.com': 'saas',
  'segment.com': 'saas',
  'mixpanel.com': 'saas',
  'amplitude.com': 'saas',
  'hotjar.com': 'saas',
  'heap.io': 'saas',
  'posthog.com': 'saas',
  'vercel.com': 'saas',
  'netlify.com': 'saas',
  'heroku.com': 'saas',
  'render.com': 'saas',
  'supabase.com': 'saas',
  'firebase.google.com': 'saas',

  // ── CMS / Website builders ──
  'wordpress.com': 'cms',
  'wordpress.org': 'cms',
  'wix.com': 'cms',
  'squarespace.com': 'cms',
  'webflow.com': 'cms',
  'ghost.org': 'cms',
  'blogger.com': 'cms',
  'medium.com': 'cms',
  'substack.com': 'cms',
  'contentful.com': 'cms',
  'sanity.io': 'cms',
  'strapi.io': 'cms',
  'drupal.org': 'cms',
  'joomla.org': 'cms',
  'weebly.com': 'cms',

  // ── Real estate ──
  '99acres.com': 'real_estate',
  'magicbricks.com': 'real_estate',
  'housing.com': 'real_estate',
  'nobroker.in': 'real_estate',
  'zillow.com': 'real_estate',
  'realtor.com': 'real_estate',
  'redfin.com': 'real_estate',
  'trulia.com': 'real_estate',
  'rightmove.co.uk': 'real_estate',
  'zoopla.co.uk': 'real_estate',
  'makaan.com': 'real_estate',
  'commonfloor.com': 'real_estate',
  'propertyfinder.ae': 'real_estate',
  'bayut.com': 'real_estate',
  'lamudi.com': 'real_estate',
};

// ─── Helper: extract root domain ─────────────────────────────────────────────

export function normalizeUrl(url: string): string {
  if (!url) return '';
  let u = url.trim();
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    u = 'https://' + u;
  }
  return u;
}

function extractRootDomain(url: string): string {
  try {
    const parsed = parseTld(normalizeUrl(url));
    return parsed.domain || '';
  } catch {
    return '';
  }
}

function extractFullHostname(url: string): string {
  try {
    const parsed = parseTld(normalizeUrl(url));
    return parsed.hostname || '';
  } catch {
    return '';
  }
}

// ─── Layer 2: URL structural scoring ─────────────────────────────────────────

function scoreFromUrl(url: string, scores: Scores): string[] {
  const evidence: string[] = [];
  const u = url.toLowerCase();
  const hostname = extractFullHostname(url);

  // Subdomain signals
  if (hostname.startsWith('app.') || hostname.startsWith('dashboard.')) {
    scores.saas += 4;
    evidence.push(`subdomain "${hostname.split('.')[0]}" → saas`);
  }
  if (hostname.startsWith('shop.') || hostname.startsWith('store.')) {
    scores.ecommerce += 3;
    evidence.push(`subdomain "${hostname.split('.')[0]}" → ecommerce`);
  }
  if (hostname.startsWith('pay.') || hostname.startsWith('payments.')) {
    scores.finance += 3;
    evidence.push(`subdomain "${hostname.split('.')[0]}" → finance`);
  }

  // Path keyword signals
  const pathSignals: [RegExp, SiteType, number, string][] = [
    [/\/(product|products|shop|store|cart|checkout|wishlist|add-to-cart)/i, 'ecommerce', 3, 'ecommerce path'],
    [/\/(listing|listings|property|properties|project|flats|villa|bhk)/i, 'real_estate', 3, 'real_estate path'],
    [/\/(pricing|dashboard|login|signup|sign-up|register|trial|demo)/i, 'saas', 2, 'saas path'],
    [/\/(portfolio|case-study|case-studies|our-work|clients)/i, 'agency', 2, 'agency path'],
    [/\/(blog|post|posts|article|category|tag|author)/i, 'cms', 2, 'cms path'],
    [/\/(transfer|send-money|wallet|transaction|account|bank)/i, 'finance', 2, 'finance path'],
    [/\/(sell|buy|bid|auction|vendor|supplier)/i, 'marketplace', 2, 'marketplace path'],
  ];

  for (const [pattern, type, points, label] of pathSignals) {
    if (pattern.test(u)) {
      scores[type] += points;
      evidence.push(`URL path matches ${label} (+${points})`);
    }
  }

  // Domain name token signals
  const domainTokens = hostname.replace(/^www\./, '').split(/[\.\-]/).filter(Boolean);
  const domainTokenSignals: [string[], SiteType, number][] = [
    [['property', 'properties', 'realty', 'estate', 'housing', 'homes', 'acres', 'acre', 'flat', 'villa', 'realtor'], 'real_estate', 3],
    [['shop', 'store', 'mart', 'bazaar', 'buy', 'sell', 'mall'], 'ecommerce', 3],
    [['app', 'dashboard', 'cloud', 'hq', 'io', 'ai'], 'saas', 2],
    [['pay', 'bank', 'finance', 'money', 'cash', 'fund', 'invest', 'trade', 'coin', 'credit'], 'finance', 3],
    [['agency', 'studio', 'creative', 'digital', 'design', 'dev', 'labs', 'works', 'craft'], 'agency', 2],
    [['blog', 'news', 'press', 'media', 'journal', 'magazine'], 'cms', 2],
    [['market', 'marketplace', 'exchange', 'trade', 'hub'], 'marketplace', 2],
  ];

  for (const [tokens, type, points] of domainTokenSignals) {
    for (const tok of domainTokens) {
      if (tokens.includes(tok)) {
        scores[type] += points;
        evidence.push(`domain token "${tok}" → ${type} (+${points})`);
        break;
      }
    }
  }

  return evidence;
}

// ─── Layer 1.5: Domain Name Scoring ──────────────────────────────────────────

function scoreFromDomain(domain: string, scores: Scores): string[] {
  const evidence: string[] = [];
  if (!domain) return evidence;
  const d = domain.toLowerCase();

  const tokens = d.split(/[\.\-]/);

  const domainSignals: [RegExp, SiteType, number, string][] = [
    [/(shop|store|cart|mall|boutique|fashion|grocery|pharmacy)/, 'ecommerce', 3, 'ecommerce domain token'],
    [/(pay|bank|wallet|loan|credit|invest|capital|finance|insurance|wealth|fund)/, 'finance', 3, 'finance domain token'],
    [/(home|homes|property|realty|estate|realtor|villa|apartment|housing|plots)/, 'real_estate', 3, 'real estate domain token'],
    [/(crm|erp|cloud|app|platform|software|dashboard|workspace|automation|analytics)/, 'saas', 3, 'saas domain token'],
    [/(agency|studio|creative|design|branding|digital|media|labs)/, 'agency', 3, 'agency domain token'],
    [/(blog|news|journal|magazine|press|daily)/, 'cms', 3, 'cms domain token'],
    [/(market|bazaar|vendor|supplier|trader|exchange|classified)/, 'marketplace', 3, 'marketplace domain token'],
  ];

  for (const [pattern, type, points, label] of domainSignals) {
    for (const tok of tokens) {
      if (pattern.test(tok)) {
        scores[type] += points;
        evidence.push(`domain token: "${tok}" → ${label} (+${points})`);
      }
    }
  }

  return evidence;
}

// ─── Layer 3.5: Enrichment Scoring ───────────────────────────────────────────

function scoreFromEnrichment(enrichment: DetectionEnrichment | undefined, scores: Scores): string[] {
  const evidence: string[] = [];
  if (!enrichment) return evidence;

  const { sitemapText, manifestText, searchSnippet, headers, redirectUrls } = enrichment;

  if (sitemapText) {
    const text = sitemapText.toLowerCase();
    if (/\/(products?|collections?|cart|checkout)/.test(text)) { scores.ecommerce += 4; evidence.push('sitemap: ecommerce paths (+4)'); }
    if (/\/(properties|real-estate|for-sale|rent|bhk)/.test(text)) { scores.real_estate += 4; evidence.push('sitemap: real estate paths (+4)'); }
    if (/\/(pricing|demo|integrations|api|dashboard)/.test(text)) { scores.saas += 4; evidence.push('sitemap: saas paths (+4)'); }
    if (/\/(blog|article|author|category)/.test(text)) { scores.cms += 4; evidence.push('sitemap: cms paths (+4)'); }
    if (/\/(pay|wallet|loan|insurance|banking)/.test(text)) { scores.finance += 4; evidence.push('sitemap: finance paths (+4)'); }
    if (/\/(vendors?|suppliers?|sell|listings)/.test(text)) { scores.marketplace += 4; evidence.push('sitemap: marketplace paths (+4)'); }
  }

  const snippetAndManifest = `${manifestText || ''} ${searchSnippet || ''}`.toLowerCase();
  if (snippetAndManifest) {
    if (/(payment platform|online payments|banking|loan|invest)/.test(snippetAndManifest)) { scores.finance += 4; evidence.push('enrichment text: finance keywords (+4)'); }
    if (/(website builder|wordpress|cms|publish)/.test(snippetAndManifest)) { scores.cms += 4; evidence.push('enrichment text: cms keywords (+4)'); }
    if (/(buy online|shop|products)/.test(snippetAndManifest)) { scores.ecommerce += 4; evidence.push('enrichment text: ecommerce keywords (+4)'); }
    if (/(software platform|book a demo|free trial)/.test(snippetAndManifest)) { scores.saas += 4; evidence.push('enrichment text: saas keywords (+4)'); }
  }

  if (headers?.['x-powered-by']?.toLowerCase().includes('shopify')) {
    scores.ecommerce += 5;
    evidence.push('headers: x-powered-by shopify (+5)');
  }

  if (redirectUrls?.some(u => u.toLowerCase().includes('/checkout'))) {
    scores.ecommerce += 4;
    evidence.push('redirects: checkout path (+4)');
  }

  if (enrichment.searchResults && enrichment.searchResults.length > 0) {
    const searchText = enrichment.searchResults
      .map(r => `${r.title} ${r.snippet}`)
      .join(' ')
      .toLowerCase();

    // Finance
    if (/(insurance|policy|policies|premium|claims?|loan|credit|banking|investment|mutual fund|sip|tax)/.test(searchText)) { scores.finance += 5; evidence.push('search results: finance keywords (+5)'); }

    // Ecommerce
    if (/(shop online|buy online|products|store|cart|checkout)/.test(searchText)) { scores.ecommerce += 4; evidence.push('search results: ecommerce keywords (+4)'); }

    // SaaS
    if (/(software platform|cloud platform|dashboard|automation|api|free trial)/.test(searchText)) { scores.saas += 4; evidence.push('search results: saas keywords (+4)'); }

    // Real estate
    if (/(property|properties|apartment|villa|rent|sale)/.test(searchText)) { scores.real_estate += 4; evidence.push('search results: real estate keywords (+4)'); }

    // CMS
    if (/(blog|news|wordpress|publishing)/.test(searchText)) { scores.cms += 3; evidence.push('search results: cms keywords (+3)'); }

    // Agency
    if (/(design agency|branding agency|digital agency|creative studio|product design)/.test(searchText)) { scores.agency += 5; evidence.push('search results: agency phrase (+5)'); }
    if (/(ux|portfolio|case studies)/.test(searchText)) { scores.agency += 4; evidence.push('search results: agency keywords (+4)'); }

    // Marketplace
    if (/(marketplace|sellers|vendors|listings)/.test(searchText)) { scores.marketplace += 3; evidence.push('search results: marketplace keywords (+3)'); }

    // Corporate
    if (/(company|official website)/.test(searchText)) { scores.corporate += 1; evidence.push('search results: corporate keywords (+1)'); }
  }

  return evidence;
}

// ─── Layer 4.5: Schema.org / JSON-LD Scoring ─────────────────────────────────

function scoreFromSchema(html: string, scores: Scores): string[] {
  const evidence: string[] = [];
  if (!html) return evidence;

  const scripts = html.match(/<script[^>]*application\/ld\+json[^>]*>(.*?)<\/script>/gs);
  if (!scripts) return evidence;

  const types = new Set<string>();

  for (const script of scripts) {
    const match = script.match(/>(.*?)<\/script>/s);
    if (match && match[1]) {
      try {
        const parsed = JSON.parse(match[1]);
        const extractType = (obj: any) => {
          if (!obj) return;
          if (Array.isArray(obj)) {
            obj.forEach(extractType);
          } else if (typeof obj === 'object') {
            if (obj['@type']) {
              const t = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']];
              t.forEach((typeStr: string) => types.add(typeStr.toLowerCase()));
            }
            Object.values(obj).forEach(extractType);
          }
        };
        extractType(parsed);
      } catch (e) {
        // ignore parse errors
      }
    }
  }

  for (const t of types) {
    if (['product', 'offer', 'aggregateoffer'].includes(t)) { scores.ecommerce += 6; evidence.push(`schema: ${t} → ecommerce (+6)`); }
    if (['financialservice', 'bankorcreditunion', 'investmentordeposit'].includes(t)) { scores.finance += 6; evidence.push(`schema: ${t} → finance (+6)`); }
    if (['realestateagent', 'residence', 'apartmentcomplex'].includes(t)) { scores.real_estate += 6; evidence.push(`schema: ${t} → real_estate (+6)`); }
    if (['softwareapplication', 'webapplication', 'saasapplication'].includes(t)) { scores.saas += 6; evidence.push(`schema: ${t} → saas (+6)`); }
    if (['article', 'blogposting', 'newsarticle'].includes(t)) { scores.cms += 6; evidence.push(`schema: ${t} → cms (+6)`); }
    if (['organization', 'corporation'].includes(t)) { scores.corporate += 2; evidence.push(`schema: ${t} → corporate (+2)`); }
  }

  return evidence;
}

// ─── Layer 3: Meta tag scoring ────────────────────────────────────────────────

function scoreFromMeta(
  meta: { title?: string; description?: string },
  scores: Scores
): string[] {
  const evidence: string[] = [];
  const text = `${meta.title ?? ''} ${meta.description ?? ''}`.toLowerCase();
  if (!text.trim()) return evidence;

  const metaSignals: [RegExp, SiteType, number, string][] = [
    // Ecommerce
    [/\b(shop|buy|order|cart|checkout|delivery|shipping|free shipping|add to bag)\b/, 'ecommerce', 3, 'ecommerce meta keywords'],
    // Marketplace
    [/\b(sellers?|buyers?|marketplace|listing|bid|supplier|vendor)\b/, 'marketplace', 2, 'marketplace meta keywords'],
    // Finance
    [/\b(payment|transfer|wallet|invest|banking|fintech|loan|insurance|credit|debit|upi|neft|rtgs)\b/, 'finance', 3, 'finance meta keywords'],
    // SaaS
    [/\b(free trial|book a demo|platform|software|saas|automat|integrat|workflow|dashboard)\b/, 'saas', 3, 'saas meta keywords'],
    // Real estate
    [/\b(real estate|buy property|flats? for sale|rent|rera|bhk|sqft|builder|apartment|villa)\b/, 'real_estate', 3, 'real_estate meta keywords'],
    // Agency
    [/\b(agency|studio|we build|we design|branding|creative|product development|design partner)\b/, 'agency', 3, 'agency meta keywords'],
    // CMS
    [/\b(blog|wordpress|wix|squarespace|webflow|cms|content management|publish)\b/, 'cms', 2, 'cms meta keywords'],
    // Corporate
    [/\b(about us|our company|mission|vision|careers|press|investor)\b/, 'corporate', 1, 'corporate meta keywords'],
  ];

  for (const [pattern, type, points, label] of metaSignals) {
    if (pattern.test(text)) {
      scores[type] += points;
      evidence.push(`meta: "${label}" (+${points})`);
    }
  }

  return evidence;
}

// ─── Layer 4: HTML body scoring ───────────────────────────────────────────────

function scoreFromHtml(html: string, scores: Scores): string[] {
  const evidence: string[] = [];
  if (!html || html.trim().length < 100) return evidence;

  const h = html.toLowerCase();

  // ── Ecommerce signals ──
  if (/add to (cart|bag|wishlist)/.test(h)) { scores.ecommerce += 4; evidence.push('html: "add to cart/bag" (+4)'); }
  if (/\b(checkout|place order|buy now|proceed to pay)\b/.test(h)) { scores.ecommerce += 3; evidence.push('html: checkout CTA (+3)'); }
  if (/\b(free (shipping|delivery)|ships? (in|within)|returns? (policy|within))\b/.test(h)) { scores.ecommerce += 3; evidence.push('html: shipping/returns (+3)'); }
  if (/\b(product (description|details|specifications|reviews?))\b/.test(h)) { scores.ecommerce += 2; evidence.push('html: product details block (+2)'); }
  if (/₹\s*\d|aed\s*\d|\$\s*\d+|£\s*\d+|€\s*\d+/.test(h)) { scores.ecommerce += 2; evidence.push('html: price literals (+2)'); }
  if (/\b(size (guide|chart|selector)|choose (size|colour|color))\b/.test(h)) { scores.ecommerce += 2; evidence.push('html: size/colour selector (+2)'); }
  if (/\b(similar products?|you (may|might) also like|customers? also (viewed|bought))\b/.test(h)) { scores.ecommerce += 2; evidence.push('html: recommendations block (+2)'); }

  // ── Marketplace signals ──
  if (/\b(post (a )?listing|sell (on|with)|become a seller|supplier login|vendor portal)\b/.test(h)) { scores.marketplace += 4; evidence.push('html: seller/vendor CTA (+4)'); }
  if (/\b(get (best )?quotes?|request (a )?quote|compare (prices?|quotes?))\b/.test(h)) { scores.marketplace += 3; evidence.push('html: quote request (+3)'); }
  if (/\b(verified (supplier|seller)|trusted (buyer|seller))\b/.test(h)) { scores.marketplace += 3; evidence.push('html: verified seller badge (+3)'); }

  // ── Finance signals ──
  if (/\b(send money|receive money|transfer funds?|bank transfer|upi|neft|rtgs|imps)\b/.test(h)) { scores.finance += 4; evidence.push('html: money transfer (+4)'); }
  if (/\b(link (bank|card|account)|add (bank|card)|debit card|credit card|net banking)\b/.test(h)) { scores.finance += 3; evidence.push('html: bank/card linking (+3)'); }
  if (/\b(mutual funds?|sip|portfolio|invest now|returns?|nav|nse|bse|sensex|nifty)\b/.test(h)) { scores.finance += 3; evidence.push('html: investment terms (+3)'); }
  if (/\b(loan|emi|interest rate|apr|repayment|lender|borrower|credit score|cibil)\b/.test(h)) { scores.finance += 3; evidence.push('html: lending/credit (+3)'); }
  if (/\b(insurance|(health|life|car|home) (insurance|plan|cover))\b/.test(h)) { scores.finance += 2; evidence.push('html: insurance (+2)'); }
  if (/\b(kyc|aml|pci dss|rbi (regulated|approved)|sebi (registered|approved))\b/.test(h)) { scores.finance += 3; evidence.push('html: regulatory compliance (+3)'); }

  // ── SaaS signals ──
  if (/\b(free trial|start (your )?free|book (a )?demo|request (a )?demo|get (started|access))\b/.test(h)) { scores.saas += 3; evidence.push('html: SaaS CTA (+3)'); }
  if (/\b(password|login|sign (in|up)|create (an )?account)\b/.test(h) && /\b(email|username)\b/.test(h)) { scores.saas += 3; evidence.push('html: auth form (+3)'); }
  if (/\b(monthly|annual|per (month|year|seat|user))[\s\S]{0,30}\b(plan|price|billing)\b/.test(h)) { scores.saas += 3; evidence.push('html: subscription pricing (+3)'); }
  if (/\b(integrat(e|ion|ions?)|api|webhook|zapier|slack|salesforce)\b/.test(h)) { scores.saas += 2; evidence.push('html: integrations (+2)'); }
  if (/\b(dashboard|workspace|project management|team collaboration)\b/.test(h)) { scores.saas += 2; evidence.push('html: dashboard/workspace (+2)'); }

  // ── Real estate signals ──
  if (/\b(bhk|sqft|sq\.?\s?ft|square feet|carpet area|super built.?up)\b/.test(h)) { scores.real_estate += 4; evidence.push('html: property area terms (+4)'); }
  if (/\brera\b/.test(h)) { scores.real_estate += 4; evidence.push('html: RERA (+4)'); }
  if (/\b(property|properties|flats? for (sale|rent)|apartments?|villas?|plots?)\b/.test(h)) { scores.real_estate += 3; evidence.push('html: property listings (+3)'); }
  if (/\b(book (a )?site visit|schedule (a )?visit|contact (the )?(builder|developer))\b/.test(h)) { scores.real_estate += 3; evidence.push('html: site visit CTA (+3)'); }
  if (/\b(possession (date|by|in)|under construction|ready to (move|possess))\b/.test(h)) { scores.real_estate += 3; evidence.push('html: possession status (+3)'); }

  // ── Agency signals ──
  if (/\b(our (work|portfolio|clients?|case studies?|projects?))\b/.test(h)) { scores.agency += 3; evidence.push('html: agency portfolio section (+3)'); }
  if (/\b(digital agency|product (studio|agency)|design (studio|agency)|branding agency|ux (studio|agency))\b/.test(h)) { scores.agency += 4; evidence.push('html: agency self-description (+4)'); }
  if (/\b(we (build|design|create|develop|craft)|for (brands?|startups?|enterprise))\b/.test(h)) { scores.agency += 2; evidence.push('html: agency mission statement (+2)'); }
  if (/\b(services?|what we do|our (services?|expertise|capabilities))\b/.test(h)) { scores.agency += 1; evidence.push('html: services section (+1)'); }

  // ── CMS signals ──
  if (/\b(powered by wordpress|wordpress\.org|wp-content|wp-includes)\b/.test(h)) { scores.cms += 5; evidence.push('html: WordPress fingerprint (+5)'); }
  if (/\b(wix\.com|squarespace\.com|webflow\.io|ghost\.io)\b/.test(h)) { scores.cms += 5; evidence.push('html: website builder fingerprint (+5)'); }
  if (/\b(subscribe (to|for) (our )?(newsletter|blog)|read (more|full article)|written by|posted (on|in)|published)\b/.test(h)) { scores.cms += 2; evidence.push('html: blog/editorial patterns (+2)'); }
  if (/\b(comments?|leave (a )?comment|reply to|pingback|trackback)\b/.test(h)) { scores.cms += 2; evidence.push('html: comments section (+2)'); }

  // ── Corporate signals (low weight, catch-all) ──
  if (/\b(investor relations?|press (room|release)|annual report|board of directors?)\b/.test(h)) { scores.corporate += 3; evidence.push('html: investor/press (+3)'); }
  if (/\b(about (us|the company)|our (mission|vision|story|team)|who we are)\b/.test(h)) { scores.corporate += 1; evidence.push('html: about/mission (+1)'); }

  return evidence;
}

// ─── Layer 5: Finalize with minimum thresholds ────────────────────────────────

function finalize(scores: Scores): { type: SiteType; confidence: 'high' | 'medium' | 'low' } {
  // Sort by score descending
  const ranked = (Object.keys(scores) as SiteType[])
    .map((t) => ({ type: t, score: scores[t] }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  const second = ranked[1];

  // Must clear minimum threshold of 4 to be classified
  if (top.score < 4) {
    return { type: 'unknown', confidence: 'low' };
  }

  // High confidence: top score ≥ 6 AND at least 2× the runner-up
  if (top.score >= 6 && top.score >= second.score * 2) {
    return { type: top.type, confidence: 'high' };
  }

  // Medium confidence: top score ≥ 4 AND at least 1.5× the runner-up
  if (top.score >= 4 && top.score >= second.score * 1.5) {
    return { type: top.type, confidence: 'medium' };
  }

  // Close race — still classify but with low confidence
  if (top.score >= 4) {
    return { type: top.type, confidence: 'low' };
  }

  return { type: 'unknown', confidence: 'low' };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const domainCache = new Map<string, CachedDetectionResult>();

function isCacheValid(entry: CachedDetectionResult): boolean {
  const now = Date.now();
  const age = now - entry.updatedAt;
  
  if (entry.confidence === 'high' && age < 30 * 24 * 60 * 60 * 1000) return true;
  if (entry.confidence === 'medium' && age < 7 * 24 * 60 * 60 * 1000) return true;
  if (entry.confidence === 'low' && age < 1 * 24 * 60 * 60 * 1000) return true;
  if (entry.type === 'unknown' && age < 6 * 60 * 60 * 1000) return true;
  
  return false;
}

/**
 * Main entry point. Call this from route.ts.
 *
 * @param bodyText  - Raw page text / crawl excerpt (may be empty if blocked)
 * @param url       - The target URL (always available)
 * @param title     - Page title from crawl or meta (optional)
 * @param description - Meta description (optional)
 */
export function detectSiteType(
  bodyText: string,
  url: string,
  title?: string,
  description?: string,
  enrichment?: DetectionEnrichment
): DetectionResult {
  const normalizedDomain = extractRootDomain(url);
  const hostname = extractFullHostname(url);
  const cacheKey = hostname || normalizedDomain || url;

  if (domainCache.has(cacheKey)) {
    const cached = domainCache.get(cacheKey)!;
    if (isCacheValid(cached)) {
      return cached;
    } else {
      domainCache.delete(cacheKey);
    }
  }

  const allEvidence: string[] = [];
  const sourceLayers: DetectionResult['sourceLayers'] = [];
  const scores: Scores = {
    ecommerce: 0,
    marketplace: 0,
    saas: 0,
    real_estate: 0,
    agency: 0,
    cms: 0,
    finance: 0,
    corporate: 0,
    unknown: 0,
  };

  const blocked = isBlockedPage(bodyText);

  // ── Layer 0: Known-domain registry ──
  let registryMatch: SiteType | undefined;
  if (hostname && KNOWN_DOMAINS[hostname]) {
    registryMatch = KNOWN_DOMAINS[hostname];
  } else if (normalizedDomain && KNOWN_DOMAINS[normalizedDomain]) {
    registryMatch = KNOWN_DOMAINS[normalizedDomain];
  }

  if (registryMatch) {
    sourceLayers.push('registry');
    const result: DetectionResult = {
      type: registryMatch,
      confidence: 'high',
      evidence: [`Known domain registry: "${hostname || normalizedDomain}" → ${registryMatch}`],
      scores,
      layer: 'registry',
      sourceLayers,
      blocked,
      normalizedDomain,
      hostname,
      source: 'rules',
      updatedAt: Date.now(),
    };
    domainCache.set(cacheKey, result as CachedDetectionResult);
    return result;
  }

  // ── Layer 1: Domain-name scoring ──
  const domainEvidence = scoreFromDomain(normalizedDomain, scores);
  if (domainEvidence.length > 0) {
    sourceLayers.push('domain');
    allEvidence.push(...domainEvidence);
  }

  // ── Layer 2: URL structural signals ──
  const urlEvidence = scoreFromUrl(url, scores);
  if (urlEvidence.length > 0) {
    sourceLayers.push('url');
    allEvidence.push(...urlEvidence);
  }

  // ── Layer 3: Enrichment scoring ──
  const enrichmentEvidence = scoreFromEnrichment(enrichment, scores);
  if (enrichmentEvidence.length > 0) {
    sourceLayers.push('enrichment');
    allEvidence.push(...enrichmentEvidence);
  }

  // ── Layer 4: Schema.org / JSON-LD ──
  const schemaEvidence = scoreFromSchema(bodyText, scores);
  if (schemaEvidence.length > 0) {
    sourceLayers.push('schema');
    allEvidence.push(...schemaEvidence);
  }

  // ── Layer 5: Meta tag scoring ──
  const metaEvidence = scoreFromMeta({ title, description }, scores);
  if (metaEvidence.length > 0) {
    sourceLayers.push('meta');
    allEvidence.push(...metaEvidence);
  }

  // ── Layer 6: HTML body scoring ──
  let htmlEvidence: string[] = [];
  if (!blocked) {
    htmlEvidence = scoreFromHtml(bodyText, scores);
    if (htmlEvidence.length > 0) {
      sourceLayers.push('html');
      allEvidence.push(...htmlEvidence);
    }
  } else {
    allEvidence.push('HTML scoring skipped (Page blocked)');
  }

  // ── Finalize ──
  const { type, confidence } = finalize(scores);

  let layer = 'fallback';
  if (sourceLayers.length > 0) {
    layer = sourceLayers[sourceLayers.length - 1]; // pick the deepest signal layer
  } else {
    sourceLayers.push('fallback');
  }

  const finalResult: DetectionResult = {
    type: type === 'unknown' ? 'unknown' : type,
    confidence,
    evidence: allEvidence.length > 0 ? allEvidence : ['No signals matched — classified as unknown'],
    scores,
    layer,
    sourceLayers,
    blocked,
    normalizedDomain,
    hostname,
    source: 'rules',
    updatedAt: Date.now(),
  };

  domainCache.set(cacheKey, finalResult as CachedDetectionResult);
  return finalResult;
}

export async function duckDuckGoSearch(query: string): Promise<Array<{
  title: string;
  snippet: string;
}>> {
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`
    );

    if (!res.ok) return [];

    const data = await res.json();

    const results: Array<{ title: string; snippet: string }> = [];

    if (data.Heading || data.AbstractText) {
      results.push({
        title: data.Heading || '',
        snippet: data.AbstractText || ''
      });
    }

    if (Array.isArray(data.RelatedTopics)) {
      for (const item of data.RelatedTopics.slice(0, 3)) {
        if (item.Text) {
          results.push({
            title: '',
            snippet: item.Text
          });
        }
      }
    }

    return results;
  } catch (err) {
    console.error('[DDG] Error:', err);
    return [];
  }
}

export async function detectSiteTypeWithFallback(
  bodyText: string,
  url: string,
  title?: string,
  description?: string,
  enrichment?: DetectionEnrichment
): Promise<DetectionResult> {
  let result = detectSiteType(bodyText, url, title, description, enrichment);

  const shouldUseDDG =
    result.type === 'unknown' ||
    result.confidence === 'low' ||
    result.blocked ||
    !bodyText ||
    bodyText.trim().length === 0;

  if (shouldUseDDG && !result.sourceLayers.includes('registry')) {
    console.log('[SITE TYPE] Triggering DuckDuckGo fallback');
    
    const queryBase = result.normalizedDomain || url;
    let searchResults: SearchResult[] = [];
    
    if (queryBase) {
      searchResults = await duckDuckGoSearch(queryBase);
      console.log('[SITE TYPE] DDG results:', searchResults.length);
    }

    if (searchResults.length > 0) {
      // Temporarily remove from cache to force re-evaluation
      const cacheKey = result.hostname || result.normalizedDomain || url;
      domainCache.delete(cacheKey);

      const enriched = detectSiteType(
        bodyText,
        url,
        title,
        description,
        {
          ...enrichment,
          searchResults
        }
      );
      
      console.log(`[SITE TYPE] Enriched result: ${enriched.type} ${enriched.confidence}`);
      
      if (enriched.type !== 'unknown') {
        result = enriched;
        result.source = 'duckduckgo_fallback';
        result.updatedAt = Date.now();
        domainCache.set(cacheKey, result as CachedDetectionResult);
      }
    }
  }

  return result;
}

/**
 * Backward-compatible wrapper — returns the same shape as the old function.
 * Existing callers in route.ts use this signature.
 */
export function runScoringPipeline(input: {
  url: string;
  domain: string;
  html: string;
  meta: { title?: string; description?: string };
}): SiteType {
  const urlToUse = normalizeUrl(input.url || input.domain);
  const result = detectSiteType(
    input.html,
    urlToUse,
    input.meta.title,
    input.meta.description
  );
  return result.type;
}

/**
 * Quick check: is this page a bot-block / access-denied page?
 */
export function isBlockedPage(text: string): boolean {
  if (!text || text.trim().length === 0) return true;
  const t = text.toLowerCase();
  return (
    t.includes('access denied') ||
    t.includes('403 forbidden') ||
    t.includes('error 403') ||
    t.includes('not allowed') ||
    t.includes('blocked') ||
    t.includes('captcha') ||
    t.includes('unusual traffic') ||
    (t.length < 300 && (t.includes('denied') || t.includes('forbidden')))
  );
}

// ─── Tests / Inline Examples ──────────────────────────────────────────────────

/**
 * Inline examples demonstrating the domain-first, crawl-assisted detection.
 */
export function __runTests() {
  console.log('amazon.com:', detectSiteType('', 'amazon.com').type); // ecommerce
  console.log('paypal.com:', detectSiteType('', 'paypal.com').type); // finance
  console.log('wordpress.com:', detectSiteType('', 'wordpress.com').type); // cms
  console.log('shoporganicfoods.com:', detectSiteType('', 'shoporganicfoods.com').type); // ecommerce
  console.log('bestloanrates.com:', detectSiteType('', 'bestloanrates.com').type); // finance
  console.log('luxuryvillasdubai.ae:', detectSiteType('', 'luxuryvillasdubai.ae').type); // real_estate
  console.log('getcrmflow.com:', detectSiteType('', 'getcrmflow.com').type); // saas
  
  const blockedResult = detectSiteType('403 forbidden', 'blocked-site.com', '', '', { sitemapText: '/products /cart' });
  console.log('blocked + sitemap:', blockedResult.type, blockedResult.evidence); // ecommerce
  
  console.log('unknown domain:', detectSiteType('', 'example-unknown-xyz.com').type); // unknown
}
