export type SiteType = 'real_estate' | 'saas' | 'corporate' | 'unknown';

export type Scores = {
  real_estate: number;
  saas: number;
  corporate: number;
};

export function isBlockedPage(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();

  return (
    t.includes('access denied') ||
    t.includes('forbidden') ||
    t.includes('not allowed') ||
    t.includes('error 403')
  );
}

const DOMAIN_CACHE = new Map<string, SiteType>();

export function scoreFromUrl(url: string, scores: Scores) {
  const u = url.toLowerCase();

  // Real estate signals
  if (u.includes('property')) scores.real_estate += 2;
  if (u.includes('properties')) scores.real_estate += 2;
  if (u.includes('listing')) scores.real_estate += 2;
  if (u.includes('project')) scores.real_estate += 1;

  // SaaS signals
  if (u.includes('app')) scores.saas += 2;
  if (u.includes('dashboard')) scores.saas += 2;
  if (u.includes('login')) scores.saas += 2;
  if (u.includes('signup')) scores.saas += 2;
  if (u.includes('pricing')) scores.saas += 1;
}

export function scoreFromSubdomain(domain: string, scores: Scores) {
  const d = domain.toLowerCase();

  if (d.startsWith('app.')) scores.saas += 3;
  if (d.startsWith('dashboard.')) scores.saas += 3;
  if (d.includes('project.')) scores.real_estate += 2;
}

export function scoreFromHtml(html: string, scores: Scores) {
  const h = html.toLowerCase();

  // SaaS: auth patterns
  if (h.includes('password') && h.includes('login')) {
    scores.saas += 3;
  }

  // SaaS: CTA patterns
  if (h.includes('free trial') || h.includes('book a demo')) {
    scores.saas += 2;
  }

  // Real estate: property patterns
  if (h.includes('bhk') && h.includes('sqft')) {
    scores.real_estate += 3;
  }

  if (h.includes('rera')) {
    scores.real_estate += 3;
  }

  // Form intent detection
  if (h.includes('budget') && h.includes('location')) {
    scores.real_estate += 2;
  }
}

export function scoreFromLinks(html: string, scores: Scores) {
  const linkCount = (html.match(/<a /gi) || []).length;

  if (linkCount > 50) {
    scores.real_estate += 2; // marketplaces tend to have many listings
  }

  if (linkCount < 10) {
    scores.corporate += 1; // simple marketing sites
  }
}

export function scoreFromMeta(meta: { title?: string; description?: string }, scores: Scores) {
  const text = `${meta.title || ''} ${meta.description || ''}`.toLowerCase();

  if (
    text.includes('buy property') ||
    text.includes('flats for sale') ||
    text.includes('real estate')
  ) {
    scores.real_estate += 2;
  }

  if (
    text.includes('free trial') ||
    text.includes('saas') ||
    text.includes('platform')
  ) {
    scores.saas += 2;
  }
}

export function finalize(scores: Scores): SiteType {
  const { real_estate, saas, corporate } = scores;

  if (real_estate >= 3 && real_estate > saas) return 'real_estate';
  if (saas >= 3 && saas > real_estate) return 'saas';

  if (real_estate === 0 && saas === 0) {
    return 'unknown';
  }

  return real_estate > saas ? 'real_estate' : 'saas';
}

export function runScoringPipeline(input: { url: string; domain: string; html: string; meta: { title?: string; description?: string } }): SiteType {
  const { url, domain, html, meta } = input;

  const scores: Scores = {
    real_estate: 0,
    saas: 0,
    corporate: 0
  };

  if (url) scoreFromUrl(url, scores);
  if (domain) scoreFromSubdomain(domain, scores);

  if (html) {
    scoreFromHtml(html, scores);
    scoreFromLinks(html, scores);
  }

  if (meta) {
    scoreFromMeta(meta, scores);
  }

  return finalize(scores);
}

export function detectFromDomainOnly(url: string): SiteType {
  let domain = '';
  try {
    domain = new URL(url).hostname.toLowerCase();
  } catch (e) {
    return 'unknown';
  }

  const score = {
    real_estate: 0,
    saas: 0
  };

  // Tokenize domain (split by dots, dashes, numbers)
  const tokens = domain.split(/[\.\-0-9]/).filter(Boolean);

  // Real estate signals
  const realEstateHints = [
    'acre',
    'property',
    'realty',
    'estate',
    'housing',
    'homes'
  ];

  for (const token of tokens) {
    if (realEstateHints.includes(token)) {
      score.real_estate += 2;
    }
  }

  // SaaS signals
  const saasHints = [
    'app',
    'cloud',
    'tech',
    'hq'
  ];

  for (const token of tokens) {
    if (saasHints.includes(token)) {
      score.saas += 2;
    }
  }

  // Special pattern: number + "acre" (e.g., 99acres)
  if (domain.match(/\d+.*acre|acre.*\d+/)) {
    score.real_estate += 3;
  }

  if (score.real_estate >= 2) return 'real_estate';
  if (score.saas >= 2) return 'saas';

  return 'unknown';
}

export function detectSiteType(
  bodyText: string,
  url: string,
  title?: string
): {
  type: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
} {
  let domain = '';
  try {
    domain = new URL(url).hostname;
  } catch (e) {
    // Ignore invalid URLs
  }

  let type: SiteType = 'unknown';
  let evidenceStr = 'Score-based detection resulted in';

  // STEP A: Check cache first
  if (domain && DOMAIN_CACHE.has(domain)) {
    type = DOMAIN_CACHE.get(domain) as SiteType;
    evidenceStr = 'Cache detection resulted in';
  } else if (isBlockedPage(bodyText)) {
    // STEP B: Handle blocked pages
    type = detectFromDomainOnly(url);
    if (domain) DOMAIN_CACHE.set(domain, type);
    evidenceStr = 'Blocked page fallback detection resulted in';
  } else {
    // STEP C: Existing scoring system
    type = runScoringPipeline({
      url: url || '',
      domain,
      html: bodyText || '',
      meta: { title }
    });
    // STEP D: Cache result
    if (domain) DOMAIN_CACHE.set(domain, type);
  }

  let confidence: 'high' | 'medium' | 'low' = 'low';
  if (type !== 'unknown' && type !== 'corporate') {
      confidence = 'medium';
  }

  return {
    type,
    confidence,
    evidence: [`${evidenceStr} ${type}`]
  };
}
