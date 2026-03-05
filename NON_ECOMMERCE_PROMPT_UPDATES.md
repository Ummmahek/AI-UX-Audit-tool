# Prompt Updates for Non-Ecommerce Site Audits

**Context**: Library v4.3 now includes general issues for non-ecommerce sites  
**Challenge**: E-commerce terminology (PLP/PDP/Checkout) not applicable to sites like Dubai Harbour

---

## KEY CHANGES NEEDED IN PROMPTS

### 1. SITE TYPE DETECTION (Add This First)

```
STEP 1: DETERMINE SITE TYPE

Analyze the website and classify as:

A. E-COMMERCE SITE
   - Has: Shopping cart, checkout, product listings with prices, add-to-cart
   - Examples: Online stores, marketplaces, retail
   - Use: All 148 issues (ecommerce + general)
   - Page types: Homepage, PLP, PDP, Cart, Checkout

B. REAL ESTATE / PROPERTY SITE
   - Has: Property listings, filters, maps, inquiry forms, no shopping cart
   - Examples: Dubai Harbour, property developers, real estate portals
   - Use: 118 issues (exclude cart/checkout)
   - Page types: Homepage, Property Listings, Property Details, Contact Forms

C. SAAS / WEB APPLICATION
   - Has: Dashboard, settings, user accounts, interactive tools
   - Examples: Notion, Figma, productivity apps
   - Use: 80 issues (general + applicable ecommerce patterns)
   - Page types: Homepage, Dashboard, Settings, Documentation

D. CONTENT / MEDIA SITE
   - Has: Articles, blog posts, news, media galleries
   - Examples: News sites, blogs, magazines
   - Use: 75 issues (general + content-focused)
   - Page types: Homepage, Article Pages, Category Pages, Search

E. DOCUMENTATION / HELP SITE
   - Has: Technical docs, guides, API references, search
   - Examples: MDN, Stripe Docs, Help Centers
   - Use: 70 issues (general + navigation/search)
   - Page types: Homepage, Doc Pages, Search, Navigation

F. CORPORATE / MARKETING SITE
   - Has: About, services, contact, landing pages, no transactions
   - Examples: Company websites, portfolios, landing pages
   - Use: 65 issues (general + trust/credibility)
   - Page types: Homepage, Service Pages, About, Contact

Based on site type, USE APPROPRIATE TERMINOLOGY throughout the audit.
```

---

### 2. PAGE TYPE MAPPING (Replace E-commerce Terms)

**OLD (E-commerce only)**:
- PLP (Product Listing Page)
- PDP (Product Detail Page)
- Cart Page
- Checkout Page

**NEW (Universal terminology)**:

```
PAGE TYPE EQUIVALENTS:

For REAL ESTATE sites:
- "Property Listings Page" = equivalent to PLP
- "Property Details Page" = equivalent to PDP
- "Inquiry/Contact Form" = equivalent to Checkout
- NO CART equivalent

For CONTENT sites:
- "Category/Archive Page" = equivalent to PLP
- "Article/Post Page" = equivalent to PDP
- NO CART/CHECKOUT equivalent

For SAAS sites:
- "Feature List/Dashboard" = equivalent to PLP
- "Feature Detail/Settings" = equivalent to PDP
- "Upgrade/Pricing Page" = equivalent to Checkout
- NO CART equivalent

For CORPORATE sites:
- "Services/Solutions Page" = equivalent to PLP
- "Service Details Page" = equivalent to PDP
- "Contact/Demo Form" = equivalent to Checkout
- NO CART equivalent

ALWAYS use site-appropriate terminology in the report, not e-commerce terms.
```

---

### 3. ISSUE FILTERING LOGIC (Critical Update)

```
ISSUE APPLICABILITY RULES:

FOR EACH ISSUE, CHECK:

1. Domain Filter:
   - If site is e-commerce → Use issues where domain = "ecommerce" OR "general"
   - If site is NOT e-commerce → Use issues where domain = "general" OR (domain = "ecommerce" AND ecommerce_relevance = "Low" OR "Medium" AND requires_cart = false AND requires_checkout = false)

2. Page Type Filter:
   - Map detected pages to issue page_types using equivalents above
   - Example: If issue applies to "PDP" and site has "Property Details", CHECK that page
   - Example: If issue applies to "Checkout" and site has NO checkout, SKIP issue

3. Hard Exclusions (Never flag for non-ecommerce):
   - requires_cart = true → SKIP
   - requires_checkout = true → SKIP
   - Issue IDs: UX-007, UX-034, UX-097 (cart-specific) → SKIP
   - Issue IDs: UX-008, UX-009, UX-035, UX-036, UX-063, UX-102, UX-105, UX-106, UX-107 (checkout-specific) → SKIP

4. Terminology Translation:
   - If issue mentions "product" and site is real estate → Replace with "property"
   - If issue mentions "add to cart" and site has "save to favorites" → Adapt accordingly
   - If issue mentions "checkout" and site has "inquiry form" → Adapt accordingly

RESULT: Only flag applicable issues with site-appropriate language.
```

---

### 4. REPORT STRUCTURE UPDATE

**OLD Structure (E-commerce only)**:
```
1. Executive Summary
2. Homepage Issues
3. Product Listing Page (PLP) Issues
4. Product Detail Page (PDP) Issues
5. Cart Issues
6. Checkout Issues
7. Global Issues
8. Mobile Issues
```

**NEW Structure (Universal)**:

```
ADAPTIVE REPORT STRUCTURE:

1. Executive Summary
   - Site type identified
   - Total issues found
   - Severity breakdown
   - Key recommendations

2. [HOMEPAGE] Issues
   - Always included
   - Same for all site types

3. [LISTING/BROWSE PAGES] Issues
   - E-commerce: "Product Listing Page (PLP)"
   - Real Estate: "Property Listings Page"
   - Content: "Category/Archive Pages"
   - SaaS: "Dashboard/Feature List"
   - Corporate: "Services/Solutions Pages"

4. [DETAIL PAGES] Issues
   - E-commerce: "Product Detail Page (PDP)"
   - Real Estate: "Property Details Page"
   - Content: "Article/Post Pages"
   - SaaS: "Feature Detail Pages"
   - Corporate: "Service Detail Pages"

5. [CONVERSION PAGES] Issues (if applicable)
   - E-commerce: "Cart Page" + "Checkout Page"
   - Real Estate: "Inquiry/Contact Forms"
   - SaaS: "Pricing/Upgrade Pages"
   - Corporate: "Contact/Demo Forms"
   - Content: SKIP (no conversion flow)

6. [NAVIGATION & SEARCH] Issues
   - Always included
   - Same terminology all sites

7. [PERFORMANCE & ACCESSIBILITY] Issues
   - Always included
   - Same for all site types

8. [MOBILE EXPERIENCE] Issues
   - Always included
   - Same for all site types

9. [CONTENT & READABILITY] Issues (if applicable)
   - More prominent for content/corporate sites
   - Less prominent for e-commerce/SaaS

USE SECTION NAMES APPROPRIATE TO SITE TYPE.
```

---

### 5. DETECTION PROMPT UPDATES

**Add to existing detection prompt**:

```
BEFORE ANALYZING ISSUES:

1. Identify site type: [E-commerce | Real Estate | SaaS | Content | Documentation | Corporate]

2. Map page types found to universal equivalents:
   - List the main page types you detected
   - Map to issue library page_types
   
3. Filter applicable issues:
   - If NOT e-commerce, exclude all issues where:
     * requires_cart = true
     * requires_checkout = true
     * Issue is cart/payment/checkout specific
   
4. Adapt terminology:
   - Replace "product" with site-appropriate term (property, article, service, etc.)
   - Replace "PLP/PDP" with equivalent terms
   - Replace "cart/checkout" with conversion equivalent or omit

5. Structure report using site-appropriate sections (see structure above)

EXAMPLE FOR REAL ESTATE SITE:

Detected site type: Real Estate / Property Development
Pages found: 
  - Homepage ✓
  - Property Listings (multiple properties with filters) → maps to PLP
  - Property Details (individual property pages) → maps to PDP
  - Contact/Inquiry Forms → maps to Checkout (conversion)
  - NO shopping cart found

Applicable issues: 118 out of 148
Excluded: 30 cart/checkout specific issues

Report sections:
  1. Executive Summary
  2. Homepage Issues
  3. Property Listings Page Issues (not "PLP")
  4. Property Details Page Issues (not "PDP")
  5. Inquiry Form Issues (not "Checkout")
  6. Navigation & Search Issues
  7. Performance & Accessibility Issues
  8. Mobile Experience Issues

Terminology adaptations:
  - "Product" → "Property"
  - "Add to cart" → "Save to favorites" (if feature exists)
  - "Purchase journey" → "Inquiry journey"
  - "Conversion" → "Lead generation"
```

---

### 6. EVIDENCE COLLECTION UPDATES

```
WHEN COLLECTING EVIDENCE:

For E-commerce sites:
  ✓ Capture: PLP, PDP, Cart, Checkout screenshots
  ✓ Test: Add to cart flow, checkout flow
  ✓ Check: Product filters, sorting, stock indicators

For NON-ecommerce sites:
  ✓ Capture: Equivalent listing/detail pages
  ✓ Test: Lead generation forms, inquiry process
  ✓ Check: Relevant filters/search for that site type
  ✗ DO NOT look for: Cart, checkout, payment, shipping

ADAPT EVIDENCE to site type - don't force e-commerce patterns on non-ecommerce sites.
```

---

### 7. EXAMPLE ISSUE REPORTING (Side-by-side)

**E-COMMERCE SITE (Dubai Fashion Store)**:
```
Issue: UX-027 - Missing sorting options
Location: Product Listing Page (PLP)
Description: The product listing page for "Women's Dresses" shows 45 products 
but lacks sorting options. Users cannot sort by price (low to high), 
popularity, or new arrivals.
Impact: Users must scroll through all 45 products to find items in their 
price range or preferred style.
Recommendation: Add sort dropdown with options: Price (Low to High), 
Price (High to Low), Newest, Most Popular, Best Rated.
```

**REAL ESTATE SITE (Dubai Harbour)**:
```
Issue: UX-027 - Missing sorting options
Location: Property Listings Page
Description: The property listings page shows 32 available units but lacks 
sorting options. Users cannot sort by price (low to high), size, or 
availability date.
Impact: Users must scroll through all 32 properties to find units in their 
budget or preferred size.
Recommendation: Add sort dropdown with options: Price (Low to High), 
Price (High to Low), Size (Largest First), Available Soon, Recently Added.
```

**CONTENT SITE (News Portal)**:
```
Issue: UX-027 - Missing sorting options
Location: Article Archive Page
Description: The "Technology" category shows 60+ articles but lacks sorting 
options. Users cannot sort by date, popularity, or reading time.
Impact: Users must scroll chronologically to find relevant articles from 
specific time periods.
Recommendation: Add sort dropdown with options: Most Recent, Most Popular, 
Oldest First, Shortest Read, Longest Read.
```

**KEY DIFFERENCE**: Same issue (UX-027), different terminology and context.

---

## CONCISE PROMPT ADDITION

**Add this to your existing audit prompt**:

```
=== SITE TYPE ADAPTATION ===

1. DETECT SITE TYPE:
   Classify as: E-commerce | Real Estate | SaaS | Content | Corporate | Documentation

2. FILTER ISSUES:
   - E-commerce sites: Use all 148 issues
   - Non-ecommerce sites: Exclude issues where requires_cart=true OR requires_checkout=true
   - Result: 80-120 applicable issues depending on site type

3. ADAPT TERMINOLOGY:
   Replace in report:
   - "Product Listing Page (PLP)" → [Site-appropriate term]
   - "Product Detail Page (PDP)" → [Site-appropriate term]
   - "Cart/Checkout" → [Conversion equivalent or omit]
   - "Product" → [Item type: property, article, service, etc.]

4. STRUCTURE REPORT:
   Use site-appropriate section names:
   ✓ Real Estate: "Property Listings" not "PLP"
   ✓ Content: "Article Pages" not "PDP"
   ✓ SaaS: "Dashboard" not "Homepage"
   ✓ Corporate: "Services Page" not "PLP"

5. EVIDENCE:
   Capture pages relevant to site type, not forced e-commerce flows.

ALWAYS adapt language to site context - never use e-commerce jargon on non-ecommerce sites.

=== END SITE TYPE ADAPTATION ===
```

---

## QUICK REFERENCE TABLE

| Site Type | Issues to Use | Exclude | Listing Page Name | Detail Page Name | Conversion Page Name |
|-----------|---------------|---------|-------------------|------------------|---------------------|
| **E-commerce** | All 148 | None | Product Listing (PLP) | Product Detail (PDP) | Cart + Checkout |
| **Real Estate** | ~118 | Cart/Checkout (30) | Property Listings | Property Details | Inquiry Forms |
| **SaaS** | ~80 | Cart/Checkout (30) | Dashboard/Features | Feature Details | Pricing/Upgrade |
| **Content** | ~75 | Cart/Checkout (30) | Category/Archive | Article/Post Page | (None) |
| **Corporate** | ~65 | Cart/Checkout (30) | Services Page | Service Details | Contact/Demo Form |
| **Documentation** | ~70 | Cart/Checkout (30) | Doc Categories | Doc Page | (None) |

---

## IMPLEMENTATION CHECKLIST

When auditing non-ecommerce sites:

- [ ] Identify site type first
- [ ] Filter to applicable issues only (exclude cart/checkout)
- [ ] Map page types to equivalents (Property Listings = PLP)
- [ ] Replace "product" with appropriate term throughout
- [ ] Use site-appropriate section names in report
- [ ] Don't force e-commerce patterns (no cart flow if none exists)
- [ ] Adapt evidence collection to site type
- [ ] Review report to ensure NO e-commerce jargon used

**Result**: Professional, contextually appropriate audit report.

---

## CRITICAL DON'TS

❌ **DON'T**:
- Use "PLP/PDP" for non-ecommerce sites
- Look for cart/checkout on sites without transactions
- Force e-commerce terminology on real estate/content sites
- Flag cart issues on sites without carts
- Use "add to cart" when site has "save to favorites"

✅ **DO**:
- Adapt terminology to site type
- Use equivalent page types appropriately
- Filter issues based on site capabilities
- Structure report for site context
- Use industry-appropriate language

---

## SUMMARY

**For Non-Ecommerce Sites Like Dubai Harbour**:

1. **Detect**: Real Estate site type
2. **Filter**: Use 118 issues (exclude 30 cart/checkout)
3. **Map**: Property Listings = PLP, Property Details = PDP
4. **Replace**: "Product" → "Property", "Cart" → (none or "Favorites")
5. **Structure**: Use "Property Listings Page Issues" not "PLP Issues"
6. **Evidence**: Capture listings, details, forms - not cart/checkout

**Result**: Contextually appropriate, professional audit using same library but adapted language.
