export function detectFromURL(url: string, title?: string): {
  type: string;
  confidence: 'medium' | 'low';
  evidence: string[];
} {
  const urlLower = url.toLowerCase();
  const titleLower = (title || '').toLowerCase();
  const combined = urlLower + ' ' + titleLower;

  if (combined.includes('residences') || combined.includes('properties') || combined.includes('realestate') || combined.includes('estate')) {
    return {
      type: 'real_estate',
      confidence: 'medium',
      evidence: ['URL contains real estate indicators'],
    };
  }

  if (urlLower.includes('shop') || urlLower.includes('store') || urlLower.includes('cart')) {
    return {
      type: 'ecommerce',
      confidence: 'medium',
      evidence: ['URL contains ecommerce indicators'],
    };
  }

  if (urlLower.includes('blog') || urlLower.includes('news') || urlLower.includes('article')) {
    return {
      type: 'content',
      confidence: 'medium',
      evidence: ['URL contains content indicators'],
    };
  }

  console.warn('[SITE TYPE] Could not reliably detect site type, defaulting to corporate');
  return {
    type: 'corporate',
    confidence: 'low',
    evidence: ['Fallback: insufficient data'],
  };
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
  // If blocked or very little content, fall back to URL-based detection
  if (bodyText.includes('Access Denied') || bodyText.length < 500) {
    console.log('[SITE TYPE] Content blocked or minimal, using URL-based detection');
    return detectFromURL(url, title);
  }

  const text = bodyText.toLowerCase();

  const indicators: Record<
    string,
    { keywords: string[]; weight: number }
  > = {
    ecommerce: {
      keywords: ['add to cart', 'shopping cart', 'checkout', 'buy now', 'add to bag', 'shop', 'price:'],
      weight: 1,
    },
    'real_estate': {
      keywords: [
        'property', 'properties', 'bedroom', 'bedrooms', 'bathroom', 'sqft', 'sq ft',
        'floor plan', 'schedule viewing', 'enquire', 'residences', 'apartments',
        'villas', 'penthouses', 'marina', 'register your interest',
      ],
      weight: 1.2,
    },
    saas: {
      keywords: ['dashboard', 'workspace', 'sign up', 'free trial', 'pricing', 'upgrade', 'api'],
      weight: 1,
    },
    content: {
      keywords: ['article', 'blog', 'published', 'author', 'read more', 'category', 'posted'],
      weight: 1,
    },
    corporate: {
      keywords: ['about us', 'our services', 'contact us', 'request quote', 'our team', 'case studies'],
      weight: 0.8,
    },
  };

  const scores: Record<string, number> = {};
  const evidenceMap: Record<string, string[]> = {};

  for (const [type, config] of Object.entries(indicators)) {
    const matches = config.keywords.filter((kw) => text.includes(kw));
    scores[type] = matches.length * config.weight;
    evidenceMap[type] = matches.slice(0, 5);
  }

  const sortedTypes = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [detectedType, score] = sortedTypes[0] as [string, number];

  let confidence: 'high' | 'medium' | 'low';
  if (score >= 5) confidence = 'high';
  else if (score >= 2) confidence = 'medium';
  else confidence = 'low';

  if (confidence === 'low') {
    console.log('[SITE TYPE] Low confidence from content, trying URL...');
    return detectFromURL(url, title);
  }

  console.log(`[SITE TYPE] Detected: ${detectedType} (confidence: ${confidence}, score: ${score})`);
  console.log(`[SITE TYPE] Evidence:`, evidenceMap[detectedType]);

  return {
    type: detectedType,
    confidence,
    evidence: evidenceMap[detectedType],
  };
}
