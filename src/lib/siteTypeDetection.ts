export function detectFromURL(url: string, title?: string): {
  type: string;
  confidence: 'medium' | 'low';
  evidence: string[];
} {
  const urlLower = url.toLowerCase();
  const titleLower = (title || '').toLowerCase();
  const combined = urlLower + ' ' + titleLower;

  if (combined.includes('residences') || combined.includes('properties') || combined.includes('realestate') || combined.includes('estate') || combined.includes('marina')) {
    return {
      type: 'real_estate',
      confidence: 'medium',
      evidence: ['URL/Title contains real estate indicators'],
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
  const urlLower = url.toLowerCase();
  const extractedTitle = (title || bodyText.match(/Title:\s*(.+)/i)?.[1] || '').toLowerCase();
  const extractedMeta = (bodyText.match(/Meta:\s*(.+)/i)?.[1] || '').toLowerCase();
  const rawText = bodyText.toLowerCase();

  const isBlocked = rawText.includes('access denied') || rawText.includes('security check') || rawText.includes('cloudflare') || rawText.includes('unusual traffic');
  const isSparse = rawText.length < 500;

  if ((isBlocked || isSparse) && !extractedTitle && !extractedMeta) {
    console.log('[SITE TYPE] Content blocked/sparse and no metadata. Using URL fallback.');
    return detectFromURL(url, title);
  }

  type Config = { strong: string[]; weak: string[]; strongWeight: number; weakWeight: number };
  
  const indicators: Record<string, Config> = {
    ecommerce: {
      strong: ['add to cart', 'shopping cart', 'buy now', 'add to bag', 'checkout'],
      weak: ['shop', 'price:', ' cart ', 'basket'],
      strongWeight: 3,
      weakWeight: 1,
    },
    'real_estate': {
      strong: ['property', 'properties', 'real estate', 'schedule viewing', 'floor plan', 'residences', 'marina', 'villas', 'penthouses', 'apartments', 'waterfront destination'],
      weak: ['bedroom', 'bedrooms', 'bathroom', 'sqft', 'sq ft', 'enquire', 'register your interest'],
      strongWeight: 3,
      weakWeight: 1.2,
    },
    saas: {
      strong: ['sign up', 'free trial', 'pricing', 'api', 'dashboard'],
      weak: ['workspace', 'upgrade'],
      strongWeight: 3,
      weakWeight: 1,
    },
    content: {
      strong: ['article', 'blog', 'published', 'author'],
      weak: ['read more', 'category', 'posted'],
      strongWeight: 3,
      weakWeight: 1,
    },
    corporate: {
      strong: ['about us', 'our services', 'case studies', 'our team'],
      weak: ['contact us', 'request quote', 'solutions'],
      strongWeight: 3,
      weakWeight: 0.8,
    },
  };

  const scores: Record<string, number> = {};
  const evidenceMap: Record<string, string[]> = {};

  const searchAreas = [
    { text: extractedTitle, multiplier: 2 },
    { text: extractedMeta, multiplier: 2 },
    { text: urlLower, multiplier: 2 },
    { text: rawText, multiplier: 1 }
  ];

  for (const [type, config] of Object.entries(indicators)) {
    let score = 0;
    const matches = new Set<string>();

    for (const { text, multiplier } of searchAreas) {
      if (!text) continue;
      
      for (const kw of config.strong) {
        if (text.includes(kw)) {
          score += config.strongWeight * multiplier;
          matches.add(kw);
        }
      }
      for (const kw of config.weak) {
        if (text.includes(kw)) {
          score += config.weakWeight * multiplier;
          matches.add(kw);
        }
      }
    }
    scores[type] = score;
    evidenceMap[type] = Array.from(matches).slice(0, 5);
  }

  const sortedTypes = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [detectedType, score] = sortedTypes[0] as [string, number];

  if (score === 0) {
    if (isBlocked || isSparse) {
      console.log('[SITE TYPE] Low confidence/blocked content, trying URL...');
      return detectFromURL(url, title);
    } else {
      console.log('[SITE TYPE] No clear signals, defaulting to corporate');
      return { type: 'corporate', confidence: 'low', evidence: ['Fallback: insufficient data'] };
    }
  }

  let confidence: 'high' | 'medium' | 'low';
  
  if (score >= 6) confidence = 'high';
  else if (score >= 3) confidence = 'medium';
  else confidence = 'low';

  if (confidence === 'low' && (isBlocked || isSparse)) {
    console.log('[SITE TYPE] Low confidence from content due to sparse/blocked text. Using URL.');
    return detectFromURL(url, title);
  }

  if (confidence === 'low' && detectedType === 'ecommerce') {
    console.log('[SITE TYPE] Weak ecommerce signals. Falling back to corporate to be conservative.');
    return { type: 'corporate', confidence: 'low', evidence: ['Fallback: weak ecommerce signals overridden'] };
  }

  console.log(`[SITE TYPE] Detected: ${detectedType} (confidence: ${confidence}, score: ${score})`);
  console.log(`[SITE TYPE] Evidence:`, evidenceMap[detectedType]);

  return {
    type: detectedType,
    confidence,
    evidence: evidenceMap[detectedType],
  };
}

