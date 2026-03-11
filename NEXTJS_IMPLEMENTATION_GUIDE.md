# Implementation Guide: Universal UX Audit Prompt for Next.js Tool

**For**: AI-assisted UX audit generator (Next.js)  
**Library**: v4.3 (148 issues - ecommerce + general)  
**Current Implementation**: `/api/generate` route with OpenAI Responses API

---

## INTEGRATION POINTS

### Where to Add the Prompt

**Primary Location**: `/api/generate` route (or equivalent API endpoint)

```typescript
// In your API route that calls OpenAI

const systemPrompt = `
You are an expert UX auditor analyzing websites using a comprehensive UX issue library.

${UNIVERSAL_AUDIT_FRAMEWORK}  // ← Insert framework here

Current Context:
- Library Version: 4.3 (148 issues)
- Library Path: ${libraryPath}
- Website URL: ${url}
- User Goal: ${goal}
- Issues Retrieved: ${retrievedIssues.length}

Follow the 13-step framework to generate a comprehensive, site-appropriate audit.
`;
```

---

## IMPLEMENTATION STRATEGY

### Phase 1: Enhance Current Keyword Retrieval

**Current**: Simple keyword matching in `src/lib/ux.ts`

**Enhancement Needed**:

```typescript
// src/lib/ux.ts - Enhanced

interface AuditContext {
  url: string;
  goal: string;
  siteType?: 'ecommerce' | 'real-estate' | 'saas' | 'content' | 'corporate' | 'documentation';
  crawlData?: {
    bodyText: string;
    screenshots: string[];
    detectedFeatures: string[];
  };
}

/**
 * STEP 1: Detect Site Type (Before Issue Retrieval)
 */
function detectSiteType(bodyText: string): {
  type: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
} {
  const indicators = {
    ecommerce: ['add to cart', 'shopping cart', 'checkout', 'buy now', 'price:', 'shipping'],
    'real-estate': ['property', 'properties', 'sqft', 'sq ft', 'bedrooms', 'bathrooms', 'floor plan', 'schedule viewing'],
    saas: ['dashboard', 'workspace', 'sign up', 'free trial', 'pricing', 'upgrade'],
    content: ['article', 'blog', 'published', 'author', 'read more', 'category'],
    corporate: ['about us', 'our services', 'contact us', 'request quote', 'case studies'],
    documentation: ['docs', 'documentation', 'api', 'guide', 'tutorial', 'reference']
  };

  const text = bodyText.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [type, keywords] of Object.entries(indicators)) {
    scores[type] = keywords.filter(keyword => text.includes(keyword)).length;
  }

  const detectedType = Object.keys(scores).reduce((a, b) => 
    scores[a] > scores[b] ? a : b
  );

  const confidence = scores[detectedType] >= 4 ? 'high' : 
                     scores[detectedType] >= 2 ? 'medium' : 'low';

  const evidence = indicators[detectedType as keyof typeof indicators]
    .filter(keyword => text.includes(keyword))
    .slice(0, 3);

  return { type: detectedType, confidence, evidence };
}

/**
 * STEP 2: Filter Issues Based on Site Type
 */
function filterIssuesBySiteType(
  allIssues: Issue[], 
  siteType: string
): Issue[] {
  if (siteType === 'ecommerce') {
    return allIssues; // Use all 148 issues
  }

  // Excluded issue IDs for non-ecommerce
  const excludedIssues = [
    'UX-007', 'UX-034', 'UX-097', // Cart-specific
    'UX-008', 'UX-009', 'UX-035', 'UX-036', // Checkout-specific
    'UX-063', 'UX-102', 'UX-105', 'UX-106', 'UX-107' // Payment/delivery
  ];

  return allIssues.filter(issue => {
    // Exclude if requires cart or checkout
    if (issue.requires_cart || issue.requires_checkout) {
      return false;
    }

    // Exclude if in excluded list
    if (excludedIssues.includes(issue.issue_id)) {
      return false;
    }

    return true;
  });
}

/**
 * STEP 3: Get Site-Appropriate Terminology
 */
function getTerminology(siteType: string) {
  const terminologyMap: Record<string, any> = {
    ecommerce: {
      listingPage: 'Product Listing Page (PLP)',
      detailPage: 'Product Detail Page (PDP)',
      conversionPage: 'Cart & Checkout',
      itemName: 'product',
      itemAction: 'purchase'
    },
    'real-estate': {
      listingPage: 'Property Listings Page',
      detailPage: 'Property Details Page',
      conversionPage: 'Inquiry Forms',
      itemName: 'property',
      itemAction: 'inquire'
    },
    saas: {
      listingPage: 'Features / Dashboard',
      detailPage: 'Feature Details',
      conversionPage: 'Pricing / Signup',
      itemName: 'feature',
      itemAction: 'subscribe'
    },
    content: {
      listingPage: 'Category / Archive Pages',
      detailPage: 'Article Pages',
      conversionPage: null,
      itemName: 'article',
      itemAction: 'read'
    },
    corporate: {
      listingPage: 'Services Page',
      detailPage: 'Service Details',
      conversionPage: 'Contact Form',
      itemName: 'service',
      itemAction: 'contact'
    },
    documentation: {
      listingPage: 'Documentation Index',
      detailPage: 'Doc Pages',
      conversionPage: null,
      itemName: 'documentation',
      itemAction: 'implement'
    }
  };

  return terminologyMap[siteType] || terminologyMap.ecommerce;
}

/**
 * Enhanced Issue Retrieval
 */
export async function retrieveRelevantIssues(
  context: AuditContext,
  topK: number = 15
): Promise<{
  issues: Issue[];
  siteType: string;
  terminology: any;
  applicableCount: number;
  totalCount: number;
}> {
  const library = await loadIssueLibrary();
  
  // STEP 1: Detect site type
  const siteTypeDetection = context.crawlData 
    ? detectSiteType(context.crawlData.bodyText)
    : { type: 'ecommerce', confidence: 'low', evidence: [] };

  // STEP 2: Filter applicable issues
  const applicableIssues = filterIssuesBySiteType(
    library.issues, 
    siteTypeDetection.type
  );

  // STEP 3: Get terminology
  const terminology = getTerminology(siteTypeDetection.type);

  // STEP 4: Keyword-based retrieval (existing logic)
  const keywords = extractKeywords(context.goal, context.url);
  const scoredIssues = applicableIssues.map(issue => ({
    issue,
    score: calculateRelevanceScore(issue, keywords)
  }));

  // STEP 5: Sort and take top K
  const topIssues = scoredIssues
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(x => x.issue);

  return {
    issues: topIssues,
    siteType: siteTypeDetection.type,
    terminology,
    applicableCount: applicableIssues.length,
    totalCount: library.issues.length
  };
}
```

---

### Phase 2: Update API Route

**File**: `/api/generate/route.ts` (or equivalent)

```typescript
// /api/generate/route.ts

export async function POST(request: Request) {
  const { url, goal, useLibrary, topK } = await request.json();

  // Step 1: Crawl website (existing Playwright logic)
  const crawlData = await crawlWebsite(url);

  // Step 2: Enhanced issue retrieval with site type detection
  const {
    issues,
    siteType,
    terminology,
    applicableCount,
    totalCount
  } = await retrieveRelevantIssues({
    url,
    goal,
    crawlData
  }, topK);

  // Step 3: Build system prompt with framework
  const systemPrompt = buildSystemPrompt({
    siteType,
    terminology,
    issues,
    crawlData,
    applicableCount,
    totalCount
  });

  // Step 4: Call OpenAI
  const response = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildUserPrompt(url, goal, crawlData) }
    ]
  });

  return NextResponse.json({
    report: response.choices[0].message.content,
    metadata: {
      siteType,
      terminology,
      issuesRetrieved: issues.length,
      applicableIssues: applicableCount,
      totalIssues: totalCount
    }
  });
}
```

---

### Phase 3: System Prompt Builder

```typescript
// src/lib/prompts.ts

function buildSystemPrompt(context: {
  siteType: string;
  terminology: any;
  issues: Issue[];
  crawlData: any;
  applicableCount: number;
  totalCount: number;
}): string {
  return `You are an expert UX auditor analyzing websites using a comprehensive issue library.

# AUDIT CONTEXT

**Site Type**: ${context.siteType}
**Confidence**: Based on detected features and content patterns
**Library Version**: 4.3 (148 total issues)
**Applicable Issues**: ${context.applicableCount} issues for ${context.siteType} sites
**Issues Retrieved**: ${context.issues.length} most relevant for this audit

**Terminology for This Site**:
- Listing Pages: ${context.terminology.listingPage}
- Detail Pages: ${context.terminology.detailPage}
- Conversion: ${context.terminology.conversionPage || 'N/A'}
- Items Called: ${context.terminology.itemName}
- Primary Action: ${context.terminology.itemAction}

# CRITICAL RULES

1. **ADAPT TERMINOLOGY**: 
   - Use "${context.terminology.listingPage}" NOT "Product Listing Page"
   - Use "${context.terminology.detailPage}" NOT "Product Detail Page"
   - Use "${context.terminology.itemName}" NOT "product"
   - NEVER use PLP/PDP for non-ecommerce sites
   ${context.siteType !== 'ecommerce' ? '- Do NOT mention cart/checkout (not applicable)' : ''}

2. **ISSUE FILTERING**:
   - Only analyze issues applicable to ${context.siteType} sites
   - ${context.siteType !== 'ecommerce' ? 'Cart/checkout issues are excluded' : ''}
   - Focus on issues relevant to detected site features

3. **EVIDENCE REQUIRED**:
   - Provide specific locations (page > section > element)
   - Include confidence level (high/medium/low)
   - Reference screenshots when available
   - State when evidence is limited

4. **COMPREHENSIVE ANALYSIS**:
   - Aim for 20-40 issues total (not just 2-3)
   - Analyze all available pages
   - Assess performance, accessibility, mobile
   - Document what couldn't be tested

# UNIVERSAL AUDIT FRAMEWORK

${getUniversalFramework()}

# RETRIEVED ISSUES FOR THIS AUDIT

${context.issues.map((issue, idx) => `
${idx + 1}. **${issue.issue_id}**: ${issue.issue_title}
   - Severity: ${issue.severity}
   - Page Type: ${issue.page_type}
   - User Problem: ${issue.user_problem}
   - Detection Signals: ${issue.signals_to_detect?.slice(0, 2).join('; ')}
   - Recommendation: ${issue.recommendation}
`).join('\n')}

# YOUR TASK

Following the 13-step Universal Audit Framework:

1. Confirm site type is ${context.siteType}
2. Map pages to appropriate terminology
3. Detect issues from the retrieved list
4. Gather evidence for each finding
5. Assess severity in context
6. Generate comprehensive report using ${context.siteType}-appropriate language

**Report Structure**:
- Executive Summary (site type, total issues, top 3 critical)
- Journey-based findings using ${context.siteType} terminology
- Performance & Accessibility
- Mobile Experience
- Suppressed Issues (with reasons)
- Priority Matrix
- Recommendations

**Quality Standards**:
- Find 20-40 issues (comprehensive audit)
- Provide evidence for each
- Use correct terminology throughout
- Include severity and priority
- Be specific and actionable
- Document coverage and limitations
`;
}
```

---

### Phase 4: User Prompt Builder

```typescript
function buildUserPrompt(
  url: string, 
  goal: string, 
  crawlData: any
): string {
  return `
# WEBSITE TO AUDIT

**URL**: ${url}
**User Goal**: ${goal}

# CRAWLED DATA

**Homepage Content** (first 500 chars):
${crawlData.bodyText.slice(0, 500)}...

**Detected Elements**:
- Text Length: ${crawlData.bodyText.length} characters
- Screenshots Captured: ${crawlData.screenshots?.length || 0}
- Pages Accessible: ${crawlData.pagesAnalyzed || 1}

${crawlData.screenshots?.length > 0 ? `
**Visual Analysis Available**: ${crawlData.screenshots.length} screenshots captured
` : ''}

# YOUR TASK

Generate a comprehensive UX audit report following the Universal Framework:

1. **Classify Site Type** (if not already detected correctly)
2. **Map Site Architecture** to appropriate terminology
3. **Detect Issues** from the retrieved library
4. **Provide Evidence** for each finding
5. **Generate Report** with correct site-specific language

**Critical Requirements**:
- Use site-appropriate terminology (no PLP/PDP if not ecommerce)
- Find 20-40 issues minimum (comprehensive, not shallow)
- Include evidence, severity, priority for each issue
- Document what you could/couldn't test
- Provide specific, actionable recommendations

Begin your audit now.
`;
}
```

---

## FRAMEWORK INTEGRATION

```typescript
// src/lib/framework.ts

export function getUniversalFramework(): string {
  return `
## UNIVERSAL AUDIT FRAMEWORK (13 Steps)

### PHASE 1: SITE ANALYSIS

**STEP 1: Detect Site Type**
- Analyze content for indicators
- Count keyword occurrences
- Determine primary purpose
- Assign confidence level

**STEP 2: Map Architecture**
- Identify page types
- Map to library equivalents
- Note site-specific features

**STEP 3: Define Journey**
- Establish user flow for this site type
- Map stages to pages
- Identify conversion points

### PHASE 2: ISSUE FILTERING

**STEP 4: Filter Applicable Issues**
- Exclude cart/checkout if not applicable
- Filter by detected features
- Select based on page availability

**STEP 5: Prioritize Detection**
- Order by page coverage
- Prioritize by severity
- Consider evidence availability

### PHASE 3: EVIDENCE COLLECTION

**STEP 6: Gather Evidence**
- Visual (screenshots)
- Structural (HTML/CSS)
- Behavioral (interactions)
- Metrics (performance/accessibility)

**STEP 7: Assess Impact**
- Context-aware severity
- User experience impact
- Business impact
- Accessibility impact

### PHASE 4: REPORT GENERATION

**STEP 8: Structure Report**
- Executive summary
- Site overview
- Journey-based findings
- Cross-cutting concerns
- Priority matrix

**STEP 9: Format Issues**
- Consistent issue format
- Evidence per finding
- Specific recommendations

**STEP 10: Adapt Terminology**
- Site-appropriate language
- No e-commerce jargon on non-ecommerce
- Validate before delivery

### PHASE 5: QUALITY ASSURANCE

**STEP 11: Quality Check**
- Completeness checklist
- Terminology accuracy
- Evidence quality
- Actionability

**STEP 12: Coverage Assessment**
- Document what was tested
- Estimate gaps
- Recommend manual review areas

### PHASE 6: IMPROVEMENT

**STEP 13: Feedback Loop**
- Note missing patterns
- Suggest library improvements
- Document detection challenges

## APPLY THIS FRAMEWORK TO EVERY AUDIT
`;
}
```

---

## UI ENHANCEMENTS

### Display Site Type Detection

```typescript
// In your frontend component

interface AuditMetadata {
  siteType: string;
  terminology: any;
  issuesRetrieved: number;
  applicableIssues: number;
  totalIssues: number;
}

function AuditResults({ report, metadata }: { report: string; metadata: AuditMetadata }) {
  return (
    <div>
      {/* Site Type Badge */}
      <div className="mb-4 p-4 bg-blue-50 rounded-lg">
        <h3 className="font-semibold">Site Analysis</h3>
        <div className="grid grid-cols-2 gap-4 mt-2">
          <div>
            <span className="text-sm text-gray-600">Detected Type:</span>
            <span className="ml-2 font-medium">{metadata.siteType}</span>
          </div>
          <div>
            <span className="text-sm text-gray-600">Applicable Issues:</span>
            <span className="ml-2 font-medium">
              {metadata.applicableIssues} / {metadata.totalIssues}
            </span>
          </div>
        </div>
        
        {/* Terminology being used */}
        <div className="mt-3 text-sm">
          <span className="text-gray-600">Terminology:</span>
          <ul className="mt-1 space-y-1">
            <li>Listing Pages: <span className="font-mono">{metadata.terminology.listingPage}</span></li>
            <li>Detail Pages: <span className="font-mono">{metadata.terminology.detailPage}</span></li>
            <li>Items: <span className="font-mono">{metadata.terminology.itemName}</span></li>
          </ul>
        </div>
      </div>

      {/* Report Content */}
      <div className="prose max-w-none">
        {/* Render report markdown */}
      </div>
    </div>
  );
}
```

---

## TESTING STRATEGY

### Test Different Site Types

```typescript
// test/audit.test.ts

describe('Site Type Detection', () => {
  test('detects e-commerce site', () => {
    const text = 'Add to cart Buy now Checkout Free shipping';
    const result = detectSiteType(text);
    expect(result.type).toBe('ecommerce');
    expect(result.confidence).toBe('high');
  });

  test('detects real estate site', () => {
    const text = 'Properties for sale 2 bedrooms 1500 sqft Schedule viewing';
    const result = detectSiteType(text);
    expect(result.type).toBe('real-estate');
  });

  test('filters issues correctly for non-ecommerce', () => {
    const allIssues = loadTestLibrary();
    const filtered = filterIssuesBySiteType(allIssues, 'real-estate');
    
    // Should exclude cart issues
    expect(filtered.find(i => i.issue_id === 'UX-007')).toBeUndefined();
    expect(filtered.find(i => i.issue_id === 'UX-008')).toBeUndefined();
    
    // Should include general issues
    expect(filtered.find(i => i.issue_id === 'UX-116')).toBeDefined();
  });
});
```

---

## DEPLOYMENT CHECKLIST

Before deploying:

- [ ] Library v4.3 in `src/data/ux_issue_library_v4.3_COMPLETE.json`
- [ ] Site type detection function added
- [ ] Issue filtering function added
- [ ] Terminology mapping added
- [ ] System prompt includes framework
- [ ] API route updated with enhanced retrieval
- [ ] UI shows site type and metadata
- [ ] Tests pass for different site types
- [ ] No "PLP/PDP" in non-ecommerce test reports
- [ ] Cart/checkout issues excluded for non-ecommerce

---

## CONFIGURATION

### Environment Variables

```bash
# .env.local

# OpenAI
OPENAI_API_KEY=sk-***

# Library configuration
UX_ISSUE_LIBRARY=src/data/ux_issue_library_v4.3_COMPLETE.json
LIBRARY_VERSION=4.3

# Feature flags
ENABLE_SITE_TYPE_DETECTION=true
ENABLE_PERFORMANCE_METRICS=true
ENABLE_ACCESSIBILITY_SCAN=true

# Report configuration
MIN_ISSUES_THRESHOLD=20  # Warn if fewer issues found
MAX_ISSUES_RETRIEVED=30  # Top K issues to retrieve
DEFAULT_SITE_TYPE=ecommerce  # Fallback if detection fails
```

---

## MIGRATION PATH

### From Current → Enhanced

**Week 1: Detection**
1. Add site type detection function
2. Add issue filtering function
3. Test on 5 different site types

**Week 2: Integration**
4. Update API route with enhanced retrieval
5. Add terminology mapping
6. Update system prompt with framework

**Week 3: UI & Testing**
7. Display site type metadata in UI
8. Add comprehensive tests
9. Test end-to-end on real sites

**Week 4: Refinement**
10. Tune detection thresholds
11. Refine terminology mappings
12. Optimize prompt length
13. Deploy to production

---

## EXPECTED IMPROVEMENTS

| Metric | Before | After |
|--------|--------|-------|
| **Site Classification** | Generic/Manual | Automatic + Confident |
| **Issue Applicability** | All 148 always | 65-148 (filtered) |
| **Terminology Errors** | Common (PLP on real estate) | Zero (validated) |
| **Issues Found** | 2-5 (shallow) | 20-40 (comprehensive) |
| **Report Quality** | Generic | Site-specific |

---

## TROUBLESHOOTING

**Problem**: Site type detected incorrectly
**Solution**: Add more indicators or adjust thresholds in `detectSiteType()`

**Problem**: Too many issues excluded
**Solution**: Review filtering logic in `filterIssuesBySiteType()`

**Problem**: Still using PLP/PDP for non-ecommerce
**Solution**: Validate terminology replacement in system prompt

**Problem**: Shallow analysis (only 2-3 issues)
**Solution**: Check if framework is being followed, increase `topK` parameter

**Problem**: Prompt too long for API
**Solution**: Reduce framework verbosity, summarize instead of full text

---

## SUMMARY

**What to Add**:
1. Site type detection (before issue retrieval)
2. Issue filtering by site type
3. Terminology mapping
4. Enhanced system prompt with framework
5. Metadata in API response
6. UI to display site type

**What Changes**:
- `src/lib/ux.ts` - Enhanced retrieval functions
- `/api/generate` - Updated with detection logic
- `src/lib/prompts.ts` - New system prompt builder
- Frontend - Display site type metadata

**What Stays**:
- Library loading mechanism
- Keyword retrieval logic (as part of Step 4)
- API structure
- UI layout

**Result**: Universal, adaptive UX audits that work correctly across all site types without hardcoding.
