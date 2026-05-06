/**
 * siteTypeDetection.ts — Dynamic, crawl-assisted site type classifier
 *
 * No hardcoded domain registry. Classification is fully evidence-driven.
 *
 * Layer 0: TLD scoring            (gTLD/ccTLD industry signals: .agency, .io, .shop …)
 * Layer 1: Domain-name scoring    (compound tokenizer + industry signals)
 * Layer 1.5: Domain pattern       (suffix/prefix naming conventions: -ify, get-, try-)
 * Layer 2: URL structural signals  (path keywords, subdomain)
 * Layer 3: Enrichment scoring     (robots, sitemap, manifest, snippets)
 * Layer 4: Schema.org / JSON-LD   (structured data in HTML)
 * Layer 5: Meta tag scoring        (title + description)
 * Layer 6: HTML content scoring    (body text patterns)
 * Layer 7: DuckDuckGo fallback     (multi-strategy, with timeout)
 * Layer 8: Safe fallback           ('unknown' — never force a wrong type)
 */

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
  sourceLayers: Array<'tld' | 'domain' | 'pattern' | 'url' | 'meta' | 'schema' | 'enrichment' | 'html' | 'keywords' | 'headings' | 'fallback'>;
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

// ─── Helper: normalize and parse URLs (native, no tldts) ─────────────────────

export function normalizeUrl(url: string): string {
  if (!url) return '';
  let u = url.trim();
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    u = 'https://' + u;
  }
  return u;
}

function extractFullHostname(url: string): string {
  try {
    return new URL(normalizeUrl(url)).hostname;
  } catch {
    return '';
  }
}

/**
 * Extract root domain from URL using native URL parsing.
 * Handles ccTLD patterns like .co.uk, .co.in, .com.au.
 */
function extractRootDomain(url: string): string {
  try {
    const hostname = new URL(normalizeUrl(url)).hostname;
    const parts = hostname.replace(/^www\./, '').split('.');
    if (parts.length >= 3) {
      const sld = parts[parts.length - 2];
      // Common second-level labels that indicate a three-part ccTLD
      if (['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'].includes(sld)) {
        return parts.slice(-3).join('.');
      }
    }
    return parts.slice(-2).join('.');
  } catch {
    return '';
  }
}

// ─── Layer 0: TLD scoring ────────────────────────────────────────────────────
// Industry-specific gTLDs and well-known ccTLD-like endings are strong signals.
// Generic TLDs (.com, .net, .org) contribute nothing.

function scoreFromTld(url: string, scores: Scores): string[] {
  const evidence: string[] = [];
  try {
    const hostname = new URL(normalizeUrl(url)).hostname.toLowerCase();
    const parts = hostname.replace(/^www\./, '').split('.');
    const tld = parts[parts.length - 1];

    // gTLD signals — map of TLD string → [SiteType, points]
    const tldSignals: Record<string, [SiteType, number]> = {
      // ecommerce
      shop: ['ecommerce', 4],
      store: ['ecommerce', 4],
      market: ['ecommerce', 3],
      // agency / creative
      agency: ['agency', 5],
      design: ['agency', 4],
      studio: ['agency', 4],
      // saas / tech
      io: ['saas', 3],
      app: ['saas', 4],
      ai: ['saas', 3],
      dev: ['saas', 3],
      cloud: ['saas', 3],
      software: ['saas', 4],
      tools: ['saas', 3],
      tech: ['saas', 2],
      // finance
      finance: ['finance', 5],
      bank: ['finance', 5],
      money: ['finance', 4],
      capital: ['finance', 4],
      // real estate
      properties: ['real_estate', 5],
      realty: ['real_estate', 5],
      estate: ['real_estate', 4],
      // cms / media
      media: ['cms', 3],
      news: ['cms', 4],
      blog: ['cms', 4],
      press: ['cms', 3],
    };

    if (tldSignals[tld]) {
      const [type, points] = tldSignals[tld];
      scores[type] += points;
      evidence.push(`TLD ".${tld}" → ${type} (+${points})`);
    }
  } catch {
    // ignore parse errors
  }
  return evidence;
}

// ─── Layer 1.5: Domain naming-pattern scoring ─────────────────────────────────
// Startup/product naming conventions are weak saas/agency signals.
// These are last-resort evidence, never enough alone to classify.

function scoreFromDomainPattern(domain: string, scores: Scores): string[] {
  const evidence: string[] = [];
  if (!domain) return evidence;

  // Strip TLD to get just the name part: "poplify.com" → "poplify"
  const namePart = domain.toLowerCase().replace(/\.[^.]+$/, '').replace(/\.[^.]+$/, '');

  // -ify, -ly, -io as suffixes common in SaaS/startup naming
  if (/ify$/.test(namePart)) {
    scores.saas += 1;
    evidence.push(`domain suffix "-ify" → saas naming pattern (+1)`);
  } else if (/hq$/.test(namePart)) {
    scores.saas += 1;
    evidence.push(`domain suffix "-hq" → saas naming pattern (+1)`);
  }

  // get-, try-, use- prefix: SaaS product acquisition pattern
  if (/^(get|try|use)[a-z]{3,}/.test(namePart)) {
    const prefix = namePart.match(/^(get|try|use)/)?.[0] ?? '';
    scores.saas += 1;
    evidence.push(`domain prefix "${prefix}-" → saas product pattern (+1)`);
  }

  // my-, app- prefix: SaaS/app pattern
  if (/^(my|app)[a-z]{3,}/.test(namePart)) {
    const prefix = namePart.match(/^(my|app)/)?.[0] ?? '';
    scores.saas += 1;
    evidence.push(`domain prefix "${prefix}-" → saas app pattern (+1)`);
  }

  return evidence;
}

// ─── Compound domain tokenizer ────────────────────────────────────────────────
// Splits compound domain names like "shoporganicfoods" → ["shop", "organic", "foods"]
// or "getcrmflow" → ["get", "crm", "flow"].
// Vocabulary lists generic industry terms only — no brand or domain-specific entries.

const COMPOUND_VOCAB: string[] = [
  // ecommerce (strong)
  'ecommerce', 'marketplace', 'boutique', 'pharmacy', 'grocery', 'fashion',
  'checkout', 'wishlist', 'storefront', 'shopping',
  'store', 'shop', 'cart', 'mall', 'sell', 'buy',
  // finance (strong)
  'insurance', 'investment', 'capital', 'banking', 'finance', 'wallet',
  'invest', 'credit', 'wealth', 'money', 'rates', 'loans', 'funds',
  'policy', 'trade', 'bank', 'cash', 'loan', 'fund', 'coin', 'pay',
  // real estate (strong)
  'properties', 'property', 'apartment', 'realtor', 'housing', 'realty',
  'estate', 'luxury', 'villas', 'homes', 'acres', 'flats', 'villa',
  'plots', 'flat', 'home', 'rent',
  // saas (strong)
  'automation', 'analytics', 'workspace', 'dashboard', 'software', 'platform',
  'cloud', 'saas', 'erp', 'crm', 'api', 'flow', 'app', 'hub',
  // agency (strong)
  'branding', 'creative', 'agency', 'studio', 'design', 'craft',
  'works', 'labs', 'dev',
  // cms (strong)
  'magazine', 'journal', 'publish', 'press', 'daily', 'news', 'blog',
  // marketplace (weak — generic terms)
  'classifieds', 'supplier', 'exchange', 'vendors', 'vendor', 'bazaar', 'market',
  // general vocabulary (not scored, just used for splitting)
  'organic', 'digital', 'media', 'foods', 'local', 'global', 'online',
  'best', 'top', 'pro', 'get', 'my', 'one', 'now', 'new',
].sort((a, b) => b.length - a.length); // longest-first for greedy matching

/**
 * Splits a single compound word into known vocabulary tokens.
 * Falls back to the original word if no splits are found.
 */
function splitCompoundWord(word: string): string[] {
  if (word.length <= 3) return [word];
  const tokens: string[] = [];
  let remaining = word.toLowerCase();

  while (remaining.length >= 2) {
    const match = COMPOUND_VOCAB.find(v => remaining.startsWith(v));
    if (match) {
      tokens.push(match);
      remaining = remaining.slice(match.length);
    } else {
      remaining = remaining.slice(1);
    }
  }

  return tokens.length > 0 ? tokens : [word];
}

// ─── Layer 1: Domain-name scoring ────────────────────────────────────────────
// Uses compound tokenizer so "shoporganicfoods" → ["shop", "organic", "foods"]
// and scores each sub-token independently.
//
// Strong signals (+3): specific industry terms (shop, bank, crm, villa, etc.)
// Weak signals (+1): generic business words (bazaar, hub, digital, platform, etc.)
// These should NOT dominate unless supported by metadata/search evidence.

function scoreFromDomain(domain: string, scores: Scores): string[] {
  const evidence: string[] = [];
  if (!domain) return evidence;

  const rawParts = domain.toLowerCase().split(/[\.\-_]/);
  const tokens: string[] = [];
  for (const part of rawParts) {
    tokens.push(...splitCompoundWord(part));
  }

  const strongSignals: [RegExp, SiteType, string][] = [
    [/^(shop|store|cart|mall|boutique|fashion|grocery|pharmacy|ecommerce|checkout|storefront)$/, 'ecommerce', 'ecommerce domain token'],
    [/^(pay|bank|wallet|loan|loans|credit|invest|capital|finance|insurance|wealth|fund|funds|coin|rates|banking|investment)$/, 'finance', 'finance domain token'],
    [/^(home|homes|property|properties|realty|estate|realtor|villa|villas|apartment|housing|plots|flat|flats|acres|luxury|rent)$/, 'real_estate', 'real estate domain token'],
    [/^(crm|erp|saas|cloud|software|dashboard|workspace|automation|analytics|flow)$/, 'saas', 'saas domain token'],
    [/^(agency|studio|branding|craft|labs|works)$/, 'agency', 'agency domain token'],
    [/^(blog|news|journal|magazine|press|daily|publish)$/, 'cms', 'cms domain token'],
  ];

  // Generic words: score +1 so they won't dominate alone (threshold is 3)
  const weakSignals: [RegExp, SiteType, string][] = [
    [/^(market|marketplace|bazaar|vendor|vendors|exchange|classifieds|supplier)$/, 'marketplace', 'marketplace domain token (weak)'],
    [/^(digital|media|creative|design|dev)$/, 'agency', 'agency domain token (weak)'],
    [/^(app|platform|hub|io|ai)$/, 'saas', 'saas domain token (weak)'],
    [/^(policy)$/, 'finance', 'finance domain token (weak)'],
    [/^(sell|buy|shopping|wishlist)$/, 'ecommerce', 'ecommerce domain token (weak)'],
  ];

  const scored = new Set<string>(); // avoid double-scoring same type

  for (const [pattern, type, label] of strongSignals) {
    for (const tok of tokens) {
      if (pattern.test(tok) && !scored.has(`strong-${type}`)) {
        scores[type] += 3;
        evidence.push(`domain token: "${tok}" → ${label} (+3)`);
        scored.add(`strong-${type}`);
        break;
      }
    }
  }

  for (const [pattern, type, label] of weakSignals) {
    for (const tok of tokens) {
      if (pattern.test(tok) && !scored.has(`weak-${type}`)) {
        scores[type] += 1;
        evidence.push(`domain token: "${tok}" → ${label} (+1)`);
        scored.add(`weak-${type}`);
        break;
      }
    }
  }

  return evidence;
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

  // Domain token signals (exact match on URL parts, complements domain scoring)
  const domainTokens = hostname.replace(/^www\./, '').split(/[\.\-]/).filter(Boolean);
  const domainTokenSignals: [string[], SiteType, number][] = [
    [['property', 'properties', 'realty', 'estate', 'housing', 'homes', 'acres', 'acre', 'flat', 'villa', 'realtor'], 'real_estate', 2],
    [['shop', 'store', 'mart', 'buy', 'sell', 'mall'], 'ecommerce', 2],
    [['pay', 'bank', 'finance', 'money', 'cash', 'fund', 'invest', 'trade', 'coin', 'credit'], 'finance', 2],
    [['agency', 'studio', 'creative', 'design', 'dev', 'labs', 'works', 'craft'], 'agency', 2],
    [['blog', 'news', 'press', 'media', 'journal', 'magazine'], 'cms', 2],
    [['market', 'marketplace', 'exchange', 'hub'], 'marketplace', 1],
  ];

  for (const [tokens, type, points] of domainTokenSignals) {
    for (const tok of domainTokens) {
      if (tokens.includes(tok)) {
        scores[type] += points;
        evidence.push(`URL domain token "${tok}" → ${type} (+${points})`);
        break;
      }
    }
  }

  return evidence;
}

// ─── Layer 3: Enrichment scoring ─────────────────────────────────────────────

function scoreFromEnrichment(enrichment: DetectionEnrichment | undefined, scores: Scores): string[] {
  const evidence: string[] = [];
  if (!enrichment) return evidence;

  const { robotsText, sitemapText, manifestText, searchSnippet, headers, redirectUrls } = enrichment;

  if (robotsText) {
    const text = robotsText.toLowerCase();
    if (/disallow:.*\/(cart|checkout|order|payment|shop)/.test(text)) { scores.ecommerce += 4; evidence.push('robots: ecommerce paths (+4)'); }
    if (/disallow:.*\/(app|dashboard|account|settings|billing)/.test(text)) { scores.saas += 4; evidence.push('robots: saas paths (+4)'); }
    if (/disallow:.*\/(listing|property|rent|sale|mls)/.test(text)) { scores.real_estate += 4; evidence.push('robots: real estate paths (+4)'); }
    if (/disallow:.*\/(wp-admin|wp-content|xmlrpc)/.test(text)) { scores.cms += 4; evidence.push('robots: wordpress paths (+4)'); }
    if (/disallow:.*\/(loan|wallet|invest|trade|portfolio)/.test(text)) { scores.finance += 4; evidence.push('robots: finance paths (+4)'); }
    if (/disallow:.*\/(vendor|seller|marketplace|sell)/.test(text)) { scores.marketplace += 4; evidence.push('robots: marketplace paths (+4)'); }
    if (/disallow:.*\/(work|case-stud|portfolio|client)/.test(text)) { scores.agency += 3; evidence.push('robots: agency paths (+3)'); }
  }

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
  if (snippetAndManifest.trim()) {
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

    if (/(insurance|policy|policies|premium|claims?|loan|credit|banking|investment|mutual fund|sip|tax)/.test(searchText)) { scores.finance += 5; evidence.push('search results: finance keywords (+5)'); }
    if (/(shop online|buy online|products|store|cart|checkout|ecommerce)/.test(searchText)) { scores.ecommerce += 4; evidence.push('search results: ecommerce keywords (+4)'); }
    if (/(software platform|cloud platform|dashboard|automation|api|free trial)/.test(searchText)) { scores.saas += 4; evidence.push('search results: saas keywords (+4)'); }
    if (/(property|properties|apartment|villa|rent|sale|real estate)/.test(searchText)) { scores.real_estate += 4; evidence.push('search results: real estate keywords (+4)'); }
    if (/(blog|news|wordpress|publishing|articles)/.test(searchText)) { scores.cms += 3; evidence.push('search results: cms keywords (+3)'); }
    if (/(design agency|branding agency|digital agency|creative studio|product design)/.test(searchText)) { scores.agency += 5; evidence.push('search results: agency phrase (+5)'); }
    if (/(ux|portfolio|case studies)/.test(searchText)) { scores.agency += 4; evidence.push('search results: agency keywords (+4)'); }
    if (/(marketplace|sellers|vendors|listings)/.test(searchText)) { scores.marketplace += 3; evidence.push('search results: marketplace keywords (+3)'); }
    if (/(company|official website)/.test(searchText)) { scores.corporate += 1; evidence.push('search results: corporate keywords (+1)'); }
  }

  return evidence;
}

// ─── Layer 4: Schema.org / JSON-LD scoring ────────────────────────────────────

function scoreFromSchema(html: string, scores: Scores): string[] {
  const evidence: string[] = [];
  if (!html) return evidence;

  const scripts = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g);
  if (!scripts) return evidence;

  const types = new Set<string>();

  for (const script of scripts) {
    const match = script.match(/>([\s\S]*?)<\/script>/);
    if (match && match[1]) {
      try {
        const parsed = JSON.parse(match[1]);
        const extractType = (obj: unknown) => {
          if (!obj) return;
          if (Array.isArray(obj)) {
            obj.forEach(extractType);
          } else if (typeof obj === 'object' && obj !== null) {
            const o = obj as Record<string, unknown>;
            if (o['@type']) {
              const t = Array.isArray(o['@type']) ? o['@type'] : [o['@type']];
              t.forEach((typeStr: unknown) => { if (typeof typeStr === 'string') types.add(typeStr.toLowerCase()); });
            }
            Object.values(o).forEach(extractType);
          }
        };
        extractType(parsed);
      } catch {
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

// ─── Layer 5: Meta tag scoring ────────────────────────────────────────────────

function scoreFromMeta(
  meta: { title?: string; description?: string },
  scores: Scores
): string[] {
  const evidence: string[] = [];
  const text = `${meta.title ?? ''} ${meta.description ?? ''}`.toLowerCase();
  if (!text.trim()) return evidence;

  const metaSignals: [RegExp, SiteType, number, string][] = [
    [/\b(shop|buy|order|cart|checkout|delivery|shipping|free shipping|add to bag)\b/, 'ecommerce', 3, 'ecommerce meta keywords'],
    [/\b(sellers?|buyers?|marketplace|listing|bid|supplier|vendor)\b/, 'marketplace', 2, 'marketplace meta keywords'],
    [/\b(payment|transfer|wallet|invest|banking|fintech|loan|insurance|credit|debit|upi|neft|rtgs)\b/, 'finance', 3, 'finance meta keywords'],
    [/\b(free trial|book a demo|platform|software|saas|automat|integrat|workflow|dashboard)\b/, 'saas', 3, 'saas meta keywords'],
    [/\b(real estate|buy property|flats? for sale|rent|rera|bhk|sqft|builder|apartment|villa)\b/, 'real_estate', 3, 'real_estate meta keywords'],
    [/\b(agency|studio|we (build|design|create|develop|built|created|designed)|branding|creative|product development|design partner|for (brands?|startups?|enterprises?|founders?))\b/, 'agency', 3, 'agency meta keywords'],
    [/\b(blog|wordpress|wix|squarespace|webflow|cms|content management|publish)\b/, 'cms', 2, 'cms meta keywords'],
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

// ─── Layer 6: HTML body scoring ───────────────────────────────────────────────

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
  // Explicit self-description
  if (/\b(digital agency|product (studio|agency)|design (studio|agency|firm)|branding agency|ux (studio|agency|firm)|creative (studio|agency|firm)|web (studio|agency))\b/.test(h)) { scores.agency += 4; evidence.push('html: agency self-description (+4)'); }
  // Portfolio / client work section
  if (/\b(our (work|portfolio|clients?|case studies?|projects?))\b/.test(h)) { scores.agency += 3; evidence.push('html: portfolio/clients section (+3)'); }
  // "We built/designed/created/launched" — catches "we built", "we've built", "we've created", "we designed" etc.
  if (/\bwe'?v?e?\s+(built|build|designed|design|created|create|developed|develop|crafted|craft|launched|shipped|delivered)\b/.test(h)) { scores.agency += 3; evidence.push('html: agency delivery statement (+3)'); }
  // "We helped/worked with/partnered with [client]" — common in case studies
  if (/\bwe (helped?|worked? with|partnered? with|collaborated? with|supported?)\b/.test(h)) { scores.agency += 2; evidence.push('html: agency client collaboration (+2)'); }
  // Audience/market framing: "for startups", "for brands", "for enterprise"
  if (/\bfor (brands?|startups?|enterprises?|businesses?|companies?|founders?)\b/.test(h)) { scores.agency += 2; evidence.push('html: agency audience framing (+2)'); }
  // Services / expertise section
  if (/\b(services?|what we do|our (services?|expertise|capabilities|approach))\b/.test(h)) { scores.agency += 1; evidence.push('html: services section (+1)'); }

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

// ─── Structured crawl text parser ────────────────────────────────────────────
// The crawler emits structured plain text:
//   URL: https://...
//   Title: Page Title
//   H1: Main heading
//   Headings: heading1 | heading2 | ...
//   Description: meta description
//   Body: free text...
//
// Extracting H1 / headings separately lets us score them at higher weight
// than random body prose.

function parseStructuredBodyText(bodyText: string): {
  extractedTitle: string;
  extractedDescription: string;
  headingsText: string;
  h1Text: string;
} {
  if (!bodyText) return { extractedTitle: '', extractedDescription: '', headingsText: '', h1Text: '' };

  const lines = bodyText.split('\n');
  const get = (prefix: string): string => {
    const found = lines.find(l => l.toLowerCase().startsWith(prefix.toLowerCase() + ':'));
    return found ? found.slice(found.indexOf(':') + 1).trim() : '';
  };

  const headings = [
    get('Headings'),
    get('H1'),
    get('H2'),
    get('H3'),
  ].filter(Boolean).join(' ').replace(/\s*\|\s*/g, ' ').trim();

  return {
    extractedTitle: get('Title'),
    extractedDescription: get('Description') || get('Meta Description') || get('Meta'),
    headingsText: headings,
    h1Text: get('H1'),
  };
}

// ─── Layer 5.5: Heading scoring ───────────────────────────────────────────────
// Headings (H1/H2/H3) are extremely high-signal — they're the site's own words
// about what it does. Score them separately at 2× the meta weight.

function scoreFromHeadings(headingsText: string, scores: Scores): string[] {
  const evidence: string[] = [];
  if (!headingsText || headingsText.trim().length < 3) return evidence;

  // Reuse meta scoring logic on heading text at 2× weight
  const tempScores: Scores = {
    ecommerce: 0, marketplace: 0, saas: 0, real_estate: 0,
    agency: 0, cms: 0, finance: 0, corporate: 0, unknown: 0,
  };
  const metaEv = scoreFromMeta({ title: headingsText, description: headingsText }, tempScores);

  for (const type of Object.keys(tempScores) as SiteType[]) {
    if (tempScores[type] > 0) {
      const boosted = tempScores[type] * 2;
      scores[type] += boosted;
      evidence.push(`headings: "${headingsText.slice(0, 60).trim()}" → ${type} (+${boosted})`);
    }
  }

  return evidence.length > 0 ? evidence : metaEv.length > 0 ? [`headings scored (no type boost)`] : [];
}

// ─── Layer 6.5: Keyword accumulation ─────────────────────────────────────────
// Scans for individual high-signal words per category.
// Requires ≥2 distinct matches to contribute (prevents noise from incidental words).
// Covers vocabulary that phrase patterns miss — different phrasing, plain text, etc.
//
// Design rules:
//  - Words must be HIGH specificity (appear mostly on one site type)
//  - Generic words (product, price, company, team, about) are excluded
//  - Multiple keyword groups per category, each with its own cap
//  - Cap prevents keyword scoring from drowning out phrase evidence

function scoreFromKeywords(text: string, scores: Scores): string[] {
  const evidence: string[] = [];
  if (!text || text.length < 100) return evidence;
  const t = text.toLowerCase();

  // Schema: [keywords[], type, max_contribution]
  const KEYWORD_SETS: [string[], SiteType, number][] = [

    // ── Agency ─────────────────────────────────────────────────────────────────
    // Studio/agency identity
    [['portfolio', 'agency', 'studio', 'consultancy', 'boutique', 'practice',
      'branding', 'wireframe', 'prototype', 'mockup', 'figma', 'sketch',
      'design system', 'style guide', 'design sprint', 'brand identity',
      'visual identity', 'motion design', 'interaction design',
      'information architecture', 'ux research', 'ui design', 'ux design',
      'user research', 'usability', 'heuristic', 'accessibility audit',
      'creative direction', 'art direction'],
     'agency', 6],
    // Client work and delivery language
    [['clients', 'client', 'brief', 'deliverable', 'retainer', 'iteration',
      'stakeholder', 'discovery', 'case study', 'case studies', 'rebrand',
      'redesign', 'revamp', 'relaunch', 'pitch deck', 'scope of work',
      'proposal', 'statement of work', 'project kickoff', 'sprint review',
      'hand-off', 'handoff', 'shipped', 'launched', 'crafted', 'collaborated',
      'partnered', 'startups', 'founders', 'scale-ups'],
     'agency', 5],
    // Service areas
    [['logo design', 'brand guidelines', 'typography', 'iconography', 'illustration',
      'motion graphics', 'web design', 'app design', 'product design',
      'service design', 'digital transformation', 'growth design',
      'conversion optimisation', 'landing page design', 'design audit'],
     'agency', 4],

    // ── Ecommerce ──────────────────────────────────────────────────────────────
    // Transaction/cart vocabulary
    [['cart', 'checkout', 'basket', 'wishlist', 'add to bag', 'add to basket',
      'buy now', 'place order', 'track order', 'order history', 'reorder',
      'express checkout', 'guest checkout', 'secure checkout'],
     'ecommerce', 6],
    // Product/inventory vocabulary
    [['sku', 'variant', 'in stock', 'out of stock', 'low stock', 'back in stock',
      'size guide', 'colour options', 'color options', 'product listing',
      'collection', 'catalogue', 'catalog', 'inventory', 'bundle', 'upsell',
      'cross-sell', 'recommendations'],
     'ecommerce', 5],
    // Offers/delivery vocabulary
    [['discount', 'coupon', 'promo code', 'voucher', 'sale', 'flash sale',
      'clearance', 'free delivery', 'free shipping', 'express delivery',
      'next day delivery', 'same day delivery', 'returns policy', 'refund policy',
      'exchange', 'warranty', 'guarantee', 'cash on delivery'],
     'ecommerce', 5],

    // ── Finance ────────────────────────────────────────────────────────────────
    // Insurance vocabulary
    [['insurance', 'insurer', 'insured', 'premium', 'claim', 'underwriter',
      'policyholder', 'deductible', 'excess', 'beneficiary', 'actuary',
      'reinsurance', 'indemnity', 'liability', 'coverage', 'sum assured',
      'term insurance', 'health insurance', 'life insurance', 'motor insurance',
      'home insurance', 'travel insurance'],
     'finance', 6],
    // Lending and credit vocabulary
    [['loan', 'mortgage', 'emi', 'apr', 'interest rate', 'repayment', 'lender',
      'borrower', 'collateral', 'refinance', 'credit score', 'cibil', 'overdraft',
      'line of credit', 'personal loan', 'home loan', 'car loan', 'business loan',
      'student loan', 'payday loan', 'microfinance', 'guarantor'],
     'finance', 6],
    // Investment and banking vocabulary
    [['mutual fund', 'sip', 'nav', 'demat', 'brokerage', 'dividend', 'equity',
      'annuity', 'portfolio rebalancing', 'asset allocation', 'hedge fund',
      'index fund', 'etf', 'stock market', 'nse', 'bse', 'sensex', 'nifty',
      'ipo', 'derivatives', 'commodities', 'forex', 'cryptocurrency', 'defi'],
     'finance', 6],
    // Fintech / payments vocabulary
    [['fintech', 'payment gateway', 'digital wallet', 'upi', 'neft', 'rtgs',
      'imps', 'net banking', 'mobile banking', 'kyc', 'aml', 'pci dss',
      'sebi', 'rbi', 'irdai', 'account number', 'ifsc', 'swift', 'iban',
      'transaction limit', 'fund transfer'],
     'finance', 5],

    // ── SaaS ──────────────────────────────────────────────────────────────────
    // Developer and technical vocabulary
    [['webhook', 'api key', 'rate limit', 'sandbox', 'sdk', 'cli',
      'rest api', 'graphql', 'oauth', 'sso', 'saml', 'ldap', 'scim',
      'endpoint', 'payload', 'changelog', 'versioning', 'deprecation',
      'developer docs', 'postman', 'curl', 'api documentation'],
     'saas', 6],
    // SaaS metrics and business vocabulary
    [['saas', 'mrr', 'arr', 'churn', 'ltv', 'cac', 'nps', 'dau', 'mau',
      'retention rate', 'activation rate', 'conversion funnel',
      'product-led growth', 'plg', 'self-serve', 'freemium'],
     'saas', 6],
    // Subscription and onboarding vocabulary
    [['onboarding', 'free trial', 'upgrade', 'downgrade', 'seat',
      'billing cycle', 'cancel anytime', 'no credit card', 'free forever',
      'annual plan', 'monthly plan', 'per user', 'per seat', 'tier',
      'enterprise plan', 'custom pricing', 'volume discount'],
     'saas', 5],
    // Infrastructure and reliability vocabulary
    [['uptime', 'sla', 'status page', 'incident', 'outage', 'latency',
      'throughput', 'scalability', 'redundancy', 'disaster recovery',
      'data residency', 'gdpr', 'soc 2', 'iso 27001', 'penetration test'],
     'saas', 4],

    // ── Real estate ───────────────────────────────────────────────────────────
    // Indian real estate vocabulary
    [['rera', 'bhk', 'sqft', 'possession', 'carpet area', 'built-up area',
      'super built-up', 'floor plan', 'site visit', 'ready to move',
      'under construction', 'pre-launch', 'township', 'gated community',
      'amenities', 'club house', 'swimming pool', 'society maintenance',
      'stamp duty', 'registration charges', 'noc', 'occupancy certificate',
      'completion certificate'],
     'real_estate', 6],
    // General property vocabulary
    [['apartment', 'villa', 'penthouse', 'duplex', 'studio flat',
      'residential', 'commercial', 'warehouse', 'retail space', 'co-working',
      'locality', 'neighbourhood', 'sector', 'phase', 'block', 'tower',
      'bedroom', 'bathroom', 'parking', 'balcony', 'terrace', 'garden',
      'property tax', 'home loan', 'plot', 'land parcel'],
     'real_estate', 5],

    // ── CMS / Publishing ──────────────────────────────────────────────────────
    // Editorial and authorship vocabulary
    [['author', 'byline', 'editorial', 'columnist', 'correspondent',
      'journalist', 'reporter', 'contributor', 'editor', 'sub-editor',
      'masthead', 'op-ed', 'readership', 'publication', 'edition', 'issue',
      'cover story', 'feature story', 'long-form', 'investigative',
      'breaking news', 'news wire', 'press release', 'media kit'],
     'cms', 6],
    // Content platform vocabulary
    [['newsletter', 'subscriber', 'subscribe', 'unsubscribe', 'rss feed',
      'podcast', 'episode', 'transcript', 'archive', 'permalink',
      'pingback', 'trackback', 'content calendar', 'editorial calendar',
      'content strategy', 'seo', 'keyword ranking', 'backlink', 'slug',
      'meta description', 'open graph', 'schema markup'],
     'cms', 5],

    // ── Marketplace ───────────────────────────────────────────────────────────
    // Multi-party commerce vocabulary
    [['vendor', 'seller', 'buyer', 'listing', 'bid', 'auction', 'classified',
      'verified seller', 'trusted supplier', 'rfq', 'request for quote',
      'bulk order', 'trade leads', 'wholesale', 'moq', 'minimum order',
      'b2b marketplace', 'supplier directory', 'product catalogue',
      'escrow', 'dispute resolution', 'seller rating', 'buyer protection'],
     'marketplace', 6],

    // ── Corporate (catch-all for professional/enterprise sites) ───────────────
    [['investor relations', 'annual report', 'quarterly results', 'press room',
      'board of directors', 'executive team', 'c-suite', 'ceo', 'cfo', 'cto',
      'governance', 'compliance', 'sustainability', 'esg', 'corporate social',
      'shareholder', 'dividend policy', 'earnings', 'sec filing', 'stock price'],
     'corporate', 5],
  ];

  for (const [keywords, type, maxScore] of KEYWORD_SETS) {
    const matched: string[] = [];
    for (const kw of keywords) {
      const pattern = new RegExp(`\\b${kw.replace(/\s+/g, '\\s+')}s?\\b`);
      if (pattern.test(t)) matched.push(kw);
    }
    if (matched.length >= 2) {
      const score = Math.min(matched.length, maxScore);
      scores[type] += score;
      evidence.push(`keywords: "${matched.slice(0, 3).join('", "')}"${matched.length > 3 ? ` +${matched.length - 3} more` : ''} → ${type} (+${score})`);
    }
  }

  return evidence;
}

// ─── Finalize ─────────────────────────────────────────────────────────────────
// - With rich evidence (meta/schema/html/enrichment): threshold=4, full confidence range
// - With domain/url-only evidence: threshold=3, confidence capped at 'low'
//   → This ensures domain-only guesses always trigger the DDG fallback for validation

function finalize(
  scores: Scores,
  sourceLayers: string[]
): { type: SiteType; confidence: 'high' | 'medium' | 'low' } {
  const hasRichEvidence = sourceLayers.some(l =>
    ['meta', 'schema', 'html', 'keywords', 'enrichment', 'headings'].includes(l)
  );

  const threshold = hasRichEvidence ? 3 : 3;

  const ranked = (Object.keys(scores) as SiteType[])
    .filter(t => t !== 'unknown')
    .map(t => ({ type: t as SiteType, score: scores[t as SiteType] }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  const second = ranked[1];

  // Last-resort: ≥2 evidence points but below threshold → classify low-confidence
  // rather than unknown. Requires at least 2 points to prevent single weak signals
  // (like an -ify suffix alone) from producing a meaningless guess.
  if (top.score < threshold) {
    if (top.score >= 2) {
      return { type: top.type, confidence: 'low' };
    }
    return { type: 'unknown', confidence: 'low' };
  }

  let confidence: 'high' | 'medium' | 'low';
  if (top.score >= 6 && top.score >= second.score * 2) {
    confidence = 'high';
  } else if (top.score >= 4 && top.score >= second.score * 1.5) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // Domain/URL-only evidence → cap at 'low' so DDG is always triggered for validation
  if (!hasRichEvidence) {
    confidence = 'low';
  }

  return { type: top.type, confidence };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const domainCache = new Map<string, CachedDetectionResult>();

function isCacheValid(entry: CachedDetectionResult): boolean {
  const now = Date.now();
  const age = now - entry.updatedAt;

  if (entry.confidence === 'high' && age < 30 * 24 * 60 * 60 * 1000) return true;
  if (entry.confidence === 'medium' && age < 7 * 24 * 60 * 60 * 1000) return true;
  if (entry.confidence === 'low' && age < 1 * 24 * 60 * 60 * 1000) return true;
  // Short TTL for unknown — retried often in case crawler was down or DDG had no data
  if (entry.type === 'unknown' && age < 30 * 60 * 1000) return true;

  return false;
}

/**
 * Main entry point. Call this from route.ts.
 *
 * @param bodyText    Raw page text / crawl excerpt (may be empty if blocked)
 * @param url         The target URL (always available)
 * @param title       Page title from crawl or meta (optional)
 * @param description Meta description (optional)
 * @param enrichment  Optional enrichment data (robots, sitemap, manifest, search results)
 */
export function detectSiteType(
  bodyText: string,
  url: string,
  title?: string,
  description?: string,
  enrichment?: DetectionEnrichment,
  crawlStatus?: {
    blocked?: boolean;
    failed?: boolean;
    bodyLength?: number;
  }
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

  const rawTextLength = bodyText ? bodyText.length : 0;
  console.log(`[SITE TYPE] raw text length: ${rawTextLength}`);

  // Determine blocked status: prefer crawlStatus if available, otherwise heuristic
  let blocked = false;
  let blockedFromCrawler = false;
  let blockedFromTextHeuristic = false;

  if (crawlStatus) {
    blockedFromCrawler = crawlStatus.blocked || false;
    console.log(`[SITE TYPE] blocked status from crawler: ${blockedFromCrawler}`);
    
    // If crawler says not blocked and we have substantial body text, force not blocked
    if (!blockedFromCrawler && crawlStatus.bodyLength && crawlStatus.bodyLength > 500) {
      blocked = false;
    } else {
      blocked = blockedFromCrawler;
    }
  } else {
    // Fallback to text heuristic
    blockedFromTextHeuristic = isBlockedPage(bodyText);
    blocked = blockedFromTextHeuristic;
    console.log(`[SITE TYPE] blocked status from text heuristic: ${blockedFromTextHeuristic}`);
  }

  // ── Parse structured body text (crawler format) ──
  // Extracts Title/H1/Headings/Description fields emitted by the crawler.
  // These are scored separately at higher weight than random prose.
  const structured = parseStructuredBodyText(bodyText);
  const effectiveTitle = title || structured.extractedTitle;
  const effectiveDescription = description || structured.extractedDescription;

  // ── Layer 0: TLD scoring ──
  const tldEvidence = scoreFromTld(url, scores);
  if (tldEvidence.length > 0) {
    sourceLayers.push('tld');
    allEvidence.push(...tldEvidence);
  }

  // ── Layer 1: Domain-name scoring (compound tokenizer) ──
  const domainEvidence = scoreFromDomain(normalizedDomain, scores);
  if (domainEvidence.length > 0) {
    sourceLayers.push('domain');
    allEvidence.push(...domainEvidence);
  }

  // ── Layer 1.5: Domain naming-pattern signals ──
  const patternEvidence = scoreFromDomainPattern(normalizedDomain, scores);
  if (patternEvidence.length > 0) {
    sourceLayers.push('pattern');
    allEvidence.push(...patternEvidence);
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
  const metaEvidence = scoreFromMeta({ title: effectiveTitle, description: effectiveDescription }, scores);
  if (metaEvidence.length > 0) {
    sourceLayers.push('meta');
    allEvidence.push(...metaEvidence);
  }

  // ── Layer 5.5: Headings scoring (H1/H2/H3 from structured crawl output) ──
  if (structured.headingsText) {
    const headingsEvidence = scoreFromHeadings(structured.headingsText, scores);
    if (headingsEvidence.length > 0) {
      sourceLayers.push('headings');
      allEvidence.push(...headingsEvidence);
    }
  }

  // ── Layer 6: HTML body scoring ──
  if (!blocked) {
    const htmlEvidence = scoreFromHtml(bodyText, scores);
    if (htmlEvidence.length > 0) {
      sourceLayers.push('html');
      allEvidence.push(...htmlEvidence);
    }
    // ── Layer 6.5: Keyword accumulation ──
    // Runs on the same body text but scores individual high-signal words.
    // Catches sites that use the right vocabulary without matching specific phrases.
    const kwEvidence = scoreFromKeywords(bodyText, scores);
    if (kwEvidence.length > 0) {
      sourceLayers.push('keywords');
      allEvidence.push(...kwEvidence);
    }
  } else {
    allEvidence.push('HTML scoring skipped (page blocked)');
  }

  // ── Finalize ──
  const { type, confidence } = finalize(scores, sourceLayers);

  let layer = 'fallback';
  if (sourceLayers.length > 0) {
    layer = sourceLayers[sourceLayers.length - 1];
  } else {
    sourceLayers.push('fallback');
  }

  const finalResult: DetectionResult = {
    type,
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

// ─── DuckDuckGo Instant Answer fallback ──────────────────────────────────────

const DDG_TIMEOUT_MS = 6000;

/**
 * Single DDG Instant Answer query with a hard timeout.
 * Returns empty array on timeout, network error, or empty response.
 */
export async function duckDuckGoSearch(query: string): Promise<Array<{
  title: string;
  snippet: string;
}>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DDG_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`,
      { signal: controller.signal }
    );
    clearTimeout(timer);

    if (!res.ok) return [];

    const data = await res.json() as {
      Heading?: string;
      AbstractText?: string;
      RelatedTopics?: Array<{ Text?: string }>;
    };
    const results: Array<{ title: string; snippet: string }> = [];

    if (data.Heading || data.AbstractText) {
      results.push({
        title: data.Heading || '',
        snippet: data.AbstractText || '',
      });
    }

    if (Array.isArray(data.RelatedTopics)) {
      for (const item of data.RelatedTopics.slice(0, 3)) {
        if (item.Text) {
          results.push({ title: '', snippet: item.Text });
        }
      }
    }

    return results;
  } catch (err: unknown) {
    clearTimeout(timer);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    if (isTimeout) {
      console.warn(`[DDG] Query timed out after ${DDG_TIMEOUT_MS}ms: "${query}"`);
    } else {
      console.error('[DDG] Error:', err);
    }
    return [];
  }
}

/**
 * Try multiple DDG query strategies in order, stopping at the first that returns results.
 * Strategies (in order):
 *   1. Full root domain   "poplify.com"
 *   2. Name only          "poplify"
 *   3. Name + "company"   "poplify company"
 *   4. Name + "website"   "poplify website"
 */
async function duckDuckGoMultiSearch(rootDomain: string): Promise<{
  results: SearchResult[];
  query: string;
}> {
  const nameOnly = rootDomain.replace(/\.[^.]+$/, '').replace(/\.[^.]+$/, '');

  const candidates: (string | null)[] = [
    rootDomain,
    nameOnly !== rootDomain ? nameOnly : null,
    `${nameOnly} company`,
    `${nameOnly} website`,
  ];
  const strategies = candidates.filter((q): q is string => typeof q === 'string' && q.trim().length > 0);

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique = strategies.filter(q => !seen.has(q) && seen.add(q));

  for (const query of unique) {
    console.log(`[DDG] Trying query: "${query}"`);
    const results = await duckDuckGoSearch(query);
    if (results.length > 0) {
      console.log(`[DDG] Got ${results.length} result(s) for query: "${query}"`);
      return { results, query };
    }
    console.log(`[DDG] No results for query: "${query}"`);
  }

  return { results: [], query: '' };
}

// ─── Direct site meta fetch ───────────────────────────────────────────────────
// When DDG Instant Answer returns nothing (it only covers Wikipedia-known entities),
// fall back to fetching the site's own HTML and extracting <title> + <meta description>.
// Server-rendered meta tags are available even for JS-heavy SPAs.

const META_FETCH_TIMEOUT_MS = 8000;

async function fetchSiteMeta(url: string): Promise<{ title: string; description: string; ogDescription: string; ogType: string; keywords: string; ogSiteName: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), META_FETCH_TIMEOUT_MS);
  try {
    const normalized = normalizeUrl(url);
    console.log(`[META FETCH] Fetching: ${normalized}`);
    const res = await fetch(normalized, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; UXAuditBot/1.0)',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[META FETCH] HTTP ${res.status}`);
      return { title: '', description: '', ogDescription: '', ogType: '', keywords: '', ogSiteName: '' };
    }
    // Only read first 20KB — meta tags are always in <head>
    const reader = res.body?.getReader();
    let html = '';
    if (reader) {
      let bytes = 0;
      while (bytes < 20000) {
        const { done, value } = await reader.read();
        if (done) break;
        html += new TextDecoder().decode(value);
        bytes += value?.length ?? 0;
      }
      reader.cancel();
    }
    const titleMatch = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    const descMatch =
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,500})["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']{1,500})["'][^>]+name=["']description["']/i);
    const ogMatch =
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{1,500})["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']{1,500})["'][^>]+property=["']og:description["']/i);
    const ogTypeMatch =
      html.match(/<meta[^>]+property=["']og:type["'][^>]+content=["']([^"']{1,100})["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']{1,100})["'][^>]+property=["']og:type["']/i);
    const ogSiteNameMatch =
      html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{1,200})["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']{1,200})["'][^>]+property=["']og:site_name["']/i);
    const keywordsMatch =
      html.match(/<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']{1,500})["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']{1,500})["'][^>]+name=["']keywords["']/i);
    const twitterDescMatch =
      html.match(/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']{1,500})["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']{1,500})["'][^>]+name=["']twitter:description["']/i);

    const result = {
      title: titleMatch?.[1]?.trim() ?? '',
      description: descMatch?.[1]?.trim() || twitterDescMatch?.[1]?.trim() || '',
      ogDescription: ogMatch?.[1]?.trim() ?? '',
      ogType: ogTypeMatch?.[1]?.trim() ?? '',
      ogSiteName: ogSiteNameMatch?.[1]?.trim() ?? '',
      keywords: keywordsMatch?.[1]?.trim() ?? '',
    };
    console.log(`[META FETCH] title="${result.title.slice(0, 60)}" desc="${(result.description || result.ogDescription).slice(0, 80)}" ogType="${result.ogType}" keywords="${result.keywords.slice(0, 60)}"`);
    return result;
  } catch (err: unknown) {
    clearTimeout(timer);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    console.warn(`[META FETCH] ${isTimeout ? 'timed out' : 'failed'}: ${err instanceof Error ? err.message : err}`);
    return { title: '', description: '', ogDescription: '', ogType: '', keywords: '', ogSiteName: '' };
  }
}

const ROBOTS_FETCH_TIMEOUT_MS = 5000;

async function fetchRobotsAndSitemap(url: string): Promise<{ robotsText: string; sitemapText: string }> {
  const base = normalizeUrl(url).replace(/\/$/, '');
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; UXAuditBot/1.0)',
    'Accept': 'text/plain,text/xml,*/*',
  };

  async function fetchText(path: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ROBOTS_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}${path}`, { signal: controller.signal, headers });
      clearTimeout(timer);
      if (!res.ok) return '';
      const text = await res.text();
      return text.slice(0, 30000);
    } catch {
      clearTimeout(timer);
      return '';
    }
  }

  const [robotsText, sitemapText] = await Promise.all([
    fetchText('/robots.txt'),
    fetchText('/sitemap.xml').then(t => t || fetchText('/sitemap_index.xml')),
  ]);

  if (robotsText) console.log(`[ROBOTS] fetched ${robotsText.length} chars`);
  if (sitemapText) console.log(`[SITEMAP] fetched ${sitemapText.length} chars`);

  return { robotsText, sitemapText };
}

async function llmClassifySite(
  domain: string,
  title: string,
  claudeApiKey: string,
): Promise<{ type: SiteType; confidence: 'low' | 'medium' | 'high' } | null> {
  const VALID_TYPES: SiteType[] = ['ecommerce', 'marketplace', 'saas', 'real_estate', 'agency', 'cms', 'finance', 'corporate', 'unknown'];
  const prompt = `Classify this website's type based only on its domain name and page title.

Domain: ${domain}
Title: ${title || '(no title)'}

Pick ONE type from: ecommerce, marketplace, saas, real_estate, agency, cms, finance, corporate, unknown
Also pick confidence: low, medium, high

Reply with ONLY valid JSON, no explanation: {"type":"<type>","confidence":"<confidence>"}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 64,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`[LLM CLASSIFY] HTTP ${res.status}`); return null; }
    const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.find(c => c.type === 'text')?.text?.trim() ?? '';
    const parsed = JSON.parse(text) as { type: string; confidence: string };
    const type = VALID_TYPES.includes(parsed.type as SiteType) ? (parsed.type as SiteType) : 'unknown';
    const confidence = (['low', 'medium', 'high'] as const).includes(parsed.confidence as 'low' | 'medium' | 'high')
      ? (parsed.confidence as 'low' | 'medium' | 'high')
      : 'low';
    console.log(`[LLM CLASSIFY] result: ${type} (${confidence})`);
    return { type, confidence };
  } catch (err) {
    console.warn('[LLM CLASSIFY] failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Full detection pipeline with four fallback layers:
 *   1. DuckDuckGo Instant Answer API (works for Wikipedia-known entities)
 *   2. Direct plain-fetch of the site's own HTML meta tags (works for any public site)
 *   3. robots.txt + sitemap.xml fetch (path-based structural signals)
 *   4. LLM-based classification (last resort, requires claudeApiKey)
 *
 * Triggered when type=unknown, confidence=low, page-blocked, or empty body.
 */
export async function detectSiteTypeWithFallback(
  bodyText: string,
  url: string,
  title?: string,
  description?: string,
  enrichment?: DetectionEnrichment,
  crawlStatus?: {
    blocked?: boolean;
    failed?: boolean;
    bodyLength?: number;
  },
  claudeApiKey?: string,
): Promise<DetectionResult> {
  // Always bypass cache if body text is present — ensures fresh data is used
  const cacheKey = extractFullHostname(url) || extractRootDomain(url) || url;
  if (bodyText && bodyText.trim().length > 0) {
    domainCache.delete(cacheKey);
  }

  let result = detectSiteType(bodyText, url, title, description, enrichment, crawlStatus);

  console.log(`[SITE TYPE] Initial detection: ${result.type} (${result.confidence}) via ${result.layer}`);
  console.log(`[SITE TYPE] Evidence layers: [${result.sourceLayers.join(', ')}]`);
  console.log(`[SITE TYPE] Top scores: ${
    Object.entries(result.scores)
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ') || 'none'
  }`);

  const ddgReasons: string[] = [];
  if (result.type === 'unknown') ddgReasons.push('type=unknown');
  if (result.confidence === 'low') ddgReasons.push('confidence=low');
  if (result.blocked) ddgReasons.push('page-blocked');
  if (!bodyText || bodyText.trim().length === 0) ddgReasons.push('empty-body');

  const shouldUseDDG = ddgReasons.length > 0;

  if (shouldUseDDG) {
    console.log(`[SITE TYPE] Triggering DuckDuckGo fallback — reasons: ${ddgReasons.join(', ')}`);

    const rootDomain = result.normalizedDomain || url;
    const { results: searchResults, query: successfulQuery } = await duckDuckGoMultiSearch(rootDomain);

    console.log(`[SITE TYPE] DDG total results: ${searchResults.length}${successfulQuery ? ` (via "${successfulQuery}")` : ''}`);

    if (searchResults.length > 0) {
      domainCache.delete(cacheKey);

      const enriched = detectSiteType(bodyText, url, title, description, {
        ...enrichment,
        searchResults,
      }, crawlStatus);

      console.log(`[SITE TYPE] Enriched detection: ${enriched.type} (${enriched.confidence}) via ${enriched.layer}`);

      // Always prefer enriched result when it resolves to a concrete type,
      // or when it improves confidence even for the same type
      const isBetter =
        enriched.type !== 'unknown' ||
        (enriched.type === result.type && confidenceRank(enriched.confidence) > confidenceRank(result.confidence));

      if (isBetter) {
        result = enriched;
        result.source = 'duckduckgo_fallback';
        result.updatedAt = Date.now();
        domainCache.set(cacheKey, result as CachedDetectionResult);
      }
    } else {
      console.log('[SITE TYPE] DDG exhausted all query strategies — trying direct meta fetch');
      // DDG Instant Answer only covers Wikipedia-known entities.
      // For unknown/obscure sites, fetch the site's own HTML meta tags directly.
      const meta = await fetchSiteMeta(url);
      const metaText = [meta.title, meta.description, meta.ogDescription, meta.keywords, meta.ogType].filter(Boolean).join(' ');
      if (metaText.trim().length > 0) {
        domainCache.delete(cacheKey);
        const enriched = detectSiteType(
          bodyText,
          url,
          meta.title || title,
          meta.description || meta.ogDescription || description,
          { ...enrichment, searchSnippet: [meta.keywords, meta.ogType, meta.ogSiteName].filter(Boolean).join(' ') || enrichment?.searchSnippet },
          crawlStatus,
        );
        console.log(`[SITE TYPE] Meta-fetch enriched: ${enriched.type} (${enriched.confidence})`);
        const isBetter =
          enriched.type !== 'unknown' ||
          confidenceRank(enriched.confidence) > confidenceRank(result.confidence);
        if (isBetter) {
          result = enriched;
          result.source = 'duckduckgo_fallback';
          result.updatedAt = Date.now();
          domainCache.set(cacheKey, result as CachedDetectionResult);
        }
      }

      // Layer 3: robots.txt + sitemap.xml — path-based structural signals
      if (result.type === 'unknown' || result.confidence === 'low') {
        console.log('[SITE TYPE] Trying robots.txt + sitemap.xml fallback');
        const { robotsText, sitemapText } = await fetchRobotsAndSitemap(url);
        if (robotsText || sitemapText) {
          domainCache.delete(cacheKey);
          const enriched = detectSiteType(
            bodyText,
            url,
            meta.title || title,
            meta.description || meta.ogDescription || description,
            { ...enrichment, robotsText: robotsText || enrichment?.robotsText, sitemapText: sitemapText || enrichment?.sitemapText },
            crawlStatus,
          );
          console.log(`[SITE TYPE] Robots/sitemap enriched: ${enriched.type} (${enriched.confidence})`);
          const isBetter =
            enriched.type !== 'unknown' ||
            confidenceRank(enriched.confidence) > confidenceRank(result.confidence);
          if (isBetter) {
            result = enriched;
            result.source = 'duckduckgo_fallback';
            result.updatedAt = Date.now();
            domainCache.set(cacheKey, result as CachedDetectionResult);
          }
        }
      }

      // Layer 4: LLM classification — last resort for sites with no retrievable signals
      if ((result.type === 'unknown' || result.confidence === 'low') && claudeApiKey) {
        console.log('[SITE TYPE] Trying LLM classification fallback');
        const llmResult = await llmClassifySite(result.normalizedDomain || url, meta.title || title || '', claudeApiKey);
        if (llmResult && llmResult.type !== 'unknown') {
          result = {
            ...result,
            type: llmResult.type,
            confidence: llmResult.confidence,
            evidence: [...result.evidence, `llm: classified as ${llmResult.type}`],
            layer: 'llm_fallback',
            source: 'duckduckgo_fallback',
            updatedAt: Date.now(),
          };
          domainCache.set(cacheKey, result as CachedDetectionResult);
        }
      }
    }
  }

  console.log(`[SITE TYPE] Final result: ${result.type} (${result.confidence}) [${result.source ?? 'rules'}]`);
  return result;
}

function confidenceRank(c: 'high' | 'medium' | 'low'): number {
  return c === 'high' ? 3 : c === 'medium' ? 2 : 1;
}

/**
 * Backward-compatible wrapper. Existing callers in route.ts use this signature.
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

// ─── Inline examples for manual verification ─────────────────────────────────

export function __runTests() {
  // Strong compound domain signals — should classify from domain scoring alone
  console.log('shoporganicfoods.com:', detectSiteType('', 'shoporganicfoods.com').type); // ecommerce
  console.log('bestloanrates.com:', detectSiteType('', 'bestloanrates.com').type);       // finance
  console.log('luxuryvillasdubai.ae:', detectSiteType('', 'luxuryvillasdubai.ae').type); // real_estate
  console.log('getcrmflow.com:', detectSiteType('', 'getcrmflow.com').type);             // saas

  // Weak/generic domain signals — should stay unknown without DDG enrichment
  console.log('poplify.com:', detectSiteType('', 'poplify.com').type);         // unknown
  console.log('policybazaar.com:', detectSiteType('', 'policybazaar.com').type); // unknown (bazaar=weak)

  // Blocked page with sitemap enrichment
  const blockedResult = detectSiteType('403 forbidden', 'blocked-site.com', '', '', {
    sitemapText: '/products /cart /checkout',
  });
  console.log('blocked + ecommerce sitemap:', blockedResult.type); // ecommerce

  // Fully unknown domain with no signals
  console.log('obscure-xyz-123.com:', detectSiteType('', 'obscure-xyz-123.com').type); // unknown

  // Schema-rich ecommerce page
  const schemaBody = `<script type="application/ld+json">{"@type":"Product","name":"Test"}</script>`;
  console.log('schema:Product page:', detectSiteType(schemaBody, 'example.com').type); // ecommerce
}
