# AI UX Audit Tool — Full Architecture & Workflow Overview

> **Purpose:** A reference document that explains every code file, every data file, and the complete end-to-end pipeline.  
> **Stack:** Next.js 14 (App Router) · TypeScript · Playwright · Cheerio · Claude / OpenRouter LLMs

---

## 1. Repository Structure

```
src/
├── app/
│   ├── page.tsx                  # Frontend UI (single-page React app)
│   └── api/generate/route.ts     # Main POST API endpoint — orchestrates everything
│
├── lib/
│   ├── crawl.ts                  # HTTP crawling with Cheerio (static HTML extraction)
│   ├── crawlPlaywright.ts        # Playwright-based JS-rendered crawl (fallback)
│   ├── detect.ts                 # Deterministic DOM-rule engine (no LLM)
│   ├── signalMatch.ts            # Keyword signal matching engine (no LLM)
│   ├── siteTypeDetection.ts      # Site type classifier (ecommerce/saas/real_estate/etc.)
│   ├── prompts.ts                # Dynamic LLM prompt builder (system + user prompts)
│   └── ux.ts                    # Core library: issue loading, retrieval, scoring, LLM passes
│
├── data/
│   └── ux_issue_library_v4.3_COMPLETE.json   # Master UX issue library (active)
│
└── scripts/
    ├── test_api.js               # Manual API tests
    ├── test_retrieve.js          # Retrieval logic tests
    ├── test_dedupe.js            # Deduplication tests
    └── validation_test.ts        # Full end-to-end validation tests
```

---

## 2. The UX Issue Library (`src/data/`)

The **brain** of the tool. A JSON array of UX issues, each structured as:

```json
{
  "issue_id": "UX-040",
  "issue_title": "Security reassurance missing near payment",
  "domain": "ecommerce",
  "page_type": ["checkout", "cart"],
  "severity": "Critical",
  "confidence_weight": 0.9,
  "detection_type": "absence",      // "presence" or "absence"
  "signals_to_detect": ["trust badge", "SSL", "padlock icon"],
  "negative_signals": ["secure checkout", "256-bit encryption"],
  "visual_confirmation_required": true,
  "requires_cart": false,
  "requires_checkout": true,
  "user_problem": "Users feel anxious entering payment details without visible security cues.",
  "recommendation": "Add SSL badge, security copy, and card icons near payment fields."
}
```

**Key fields explained:**
| Field | Purpose |
|---|---|
| `issue_id` | Unique ID (UX-XXX or DET-XXX). Every finding in the report must reference one. |
| `detection_type` | `"presence"` = flag if signal IS found; `"absence"` = flag if signal is MISSING |
| `signals_to_detect` | Terms the tool searches for in crawl text / screenshot OCR |
| `negative_signals` | If ANY of these are found, the issue is suppressed (false positive guard) |
| `confidence_weight` | 0–1 weight; affects retrieval scoring (higher = surfaced more often) |
| `visual_confirmation_required` | `true` = LLM MUST see it in a screenshot; cannot be inferred from crawl |
| `requires_cart` / `requires_checkout` | Used to exclude issues from non-ecommerce sites |

**Library evolution:** v1 → v4.3_COMPLETE — the active file has ~350+ issues spanning ecommerce, real estate, SaaS, corporate, and content sites.

---

## 3. Full End-to-End Pipeline

```
User submits URL + Goal + optional Screenshots
          │
          ▼
  ┌─────────────────────────────────────────────┐
  │         API Route  (route.ts)               │
  │                                             │
  │  1. Parse request (URL, goal, screenshots)  │
  │  2. CRAWL the URL (crawl.ts → Playwright?)  │
  │  3. Run DOM checks → Deterministic issues   │
  │  4. Detect site type (siteTypeDetection.ts) │
  │  5. Filter library for site type            │
  │  6. IMAGE DETECTION PASS (LLM Vision)       │
  │  7. KEYWORD RETRIEVAL (ux.ts)               │
  │  8. SIGNAL MATCHING (signalMatch.ts)        │
  │  9. BUILD PROMPTS (prompts.ts / ux.ts)      │
  │  10. MAIN LLM CALL (Claude or OpenRouter)   │
  │  11. DEDUPLICATE report text                │
  │  12. Return JSON response                   │
  └─────────────────────────────────────────────┘
          │
          ▼
     Frontend renders report (page.tsx)
```

---

## 4. File-by-File Deep Dive

---

### `src/app/api/generate/route.ts` — The Orchestrator

**Role:** The single POST endpoint that drives the entire pipeline.

**Step-by-step flow:**

#### Step 1 — Request Parsing
```
parseRequest() → extracts: url, goal, model, topK, screenshots (File[])
```
Handles both `multipart/form-data` (with screenshots) and plain JSON.

#### Step 2 — HTTP Crawl
```typescript
crawlKeyPaths(url)    // from crawl.ts
```
Fetches homepage + up to 4 key pages (category, product, cart, checkout).  
If the crawl returns thin content (JS-rendered site), it **escalates to Playwright**:
```typescript
if (shouldUsePlaywright(combinedBodyText)) {
  const pwResult = await crawlWebsite(url);  // crawlPlaywright.ts
}
```

#### Step 3 — Deterministic DOM Detection
```typescript
runDeterministicDetection(pages, screenshotOcrText)  // detect.ts
```
Zero-LLM rule engine runs against the DOM flags extracted by Cheerio.

#### Step 4 — Site Type Detection
```typescript
detectSiteType(crawlContext, url)  // siteTypeDetection.ts
```
Returns: `ecommerce | real_estate | saas | content | corporate | documentation`

#### Step 5 — Library Filtering
```typescript
filterApplicableIssues(issueLibrary, siteType)
```
Strips cart/checkout issues for non-ecommerce sites.

#### Step 6 — Image Detection Pass (Vision LLM)
```typescript
imageDetectionPass(screenshotUrls, visionLibrary, apiKey, useClaude, goal)
```
Only runs when screenshots are uploaded. Uses Claude or OpenRouter with vision.  
Returns: `[{ issue_id, confidence, evidence_summary }]`

Before calling, it strips "purely DOM-checkable" issues from the vision library (e.g. `DET-001` through `DET-017`) to avoid asking the LLM to do what rules already handle.  
Then ranks the remaining issues by relevance to the audit goal and **caps at top 15** to keep the prompt small.

#### Step 7 — Keyword Retrieval
```typescript
retrieveRelevantIssues(url, goal, topK, crawlContext, screenshotText, hasScreenshots, imageDetected)
```
Returns the top-K most relevant issues from the library using multi-signal scoring (see Section 5).  
Image-detected issues from Step 6 are **force-included** in the top, even if they fall outside topK.

#### Step 8 — Signal Matching / Validation (replaces LLM validation)
```typescript
deterministicSignalCheck(issue, crawlText, screenshotText)  // signalMatch.ts
```
Runs on every retrieved issue. Issues are:
- **Always kept** if `source === 'deterministic'` (from detect.ts)
- **Always kept** if `imageConfirmed === true` (from Step 6)  
- **Suppressed** if negative signals match OR no positive signals found  
- **Kept** with updated confidence score otherwise

#### Step 9 — Prompt Building
```typescript
buildCompanyGroundedMessages(url, goal, validatedIssues, suppressedIssues)
// calls → buildDynamicSystemPrompt() + buildDynamicUserPrompt() from prompts.ts
```

#### Step 10 — Main LLM Call
Tries **Claude** first (model rotation: Haiku → Sonnet → Opus).  
Falls back to **OpenRouter** if Claude fails or is unconfigured.  
Screenshots are attached to the OpenRouter call as `image_url` parts.

#### Step 11 — Report Deduplication
```typescript
dedupeReportText(report)
```
Post-processes LLM output to remove duplicate UX-### entries, keeping the paragraph with the most evidence keywords.

#### Step 12 — Response
```json
{
  "report": "...",
  "retrievedIssues": [...],
  "deterministicIssues": [...],
  "suppressedIssues": [...],
  "metadata": { "siteType": "...", "applicableIssues": 120, ... }
}
```

---

### `src/lib/crawl.ts` — Static HTTP Crawler

**Role:** Fetches HTML from up to 5 pages using native `fetch`. Parses with Cheerio.

**Key functions:**

| Function | What it does |
|---|---|
| `crawlKeyPaths(url)` | Entry point. Fetches home + category + product + cart + checkout |
| `fetchHtmlSafe()` | Secure fetch with 12s timeout, 1MB cap, bot-protection detection, SSRF guard (DNS resolution, private IP blocking) |
| `extractPageExcerpt()` | Parses HTML → structured excerpt: title, meta, H1, headings, button text, form fields, body snippet, internal links |
| `runDomChecks()` | Produces `DomChecks` struct from Cheerio-parsed DOM (trust badges, breadcrumbs, search bar, CTA counts, form labels, alt texts, heading hierarchy, etc.) |
| `pickBestLink()` | Heuristically picks the best category/product/cart/checkout URL from internal links using RegExp patterns |
| `detectBotProtection()` | Checks for Cloudflare, 403/429/503 codes, and bot challenge HTML |

**Page excerpt output format:**
```
URL: https://example.com/product/123
Title: Example Product
Meta: Description text...
H1: Product Name
Headings: Section 1 | Section 2
Buttons/links (sample): Add to Cart | Wishlist | Share
Form fields (sample): Email | Password | Submit
Visible text (snippet): ...body text...
```

---

### `src/lib/crawlPlaywright.ts` — JS-Rendered Crawler (Fallback)

**Role:** Headless Chromium via `playwright-extra` for sites that block bots or require JS to render.

**When it triggers:**
```typescript
shouldUsePlaywright(bodyText) // returns true when crawl text is <200 chars OR fails real-content test
```

**Stealth techniques:**
- Rotating User-Agent (Chrome/Firefox/Safari variants)
- `navigator.webdriver = false` override
- Real browser HTTP headers (`Sec-Fetch-*`, `Accept-Language`)
- Cookie consent auto-dismissal (Accept / Accept All buttons)
- `networkidle` wait + 3s delay for dynamic content

**Output:** `{ bodyText, title, screenshots: Buffer[], blocked: boolean }`  
Screenshots are converted to base64 data URLs and merged into `allScreenshotUrls`.

---

### `src/lib/siteTypeDetection.ts` — Site Type Classifier

**Role:** Two-stage classifier: content body first, URL-based fallback.

**Stage 1 — Keyword Scoring:**
Counts weighted keyword hits per category:
| Category | Sample Keywords | Weight |
|---|---|---|
| `ecommerce` | "add to cart", "checkout", "buy now" | 1.0 |
| `real_estate` | "property", "bedroom", "sqft", "enquire" | 1.2 |
| `saas` | "dashboard", "free trial", "pricing", "api" | 1.0 |
| `content` | "article", "blog", "author", "read more" | 1.0 |
| `corporate` | "about us", "our services", "case studies" | 0.8 |

Score ≥5 → `high` confidence; ≥2 → `medium`; <2 → falls back to Stage 2.

**Stage 2 — URL pattern matching:**  
Checks URL for `/shop`, `/cart`, `/residences`, `/blog`, etc. Returns `low` confidence.

---

### `src/lib/detect.ts` — Deterministic DOM Rule Engine

**Role:** Zero-LLM, 100% deterministic. Runs CSS/regex rules against `DomChecks` flags.

**Rules defined (DET-001 to DET-017 + UX library overlaps):**

| Rule ID | Condition | Evidence |
|---|---|---|
| `DET-001` | `images_missing_alt > 0` | "Found N images with missing alt" |
| `DET-002` | `has_placeholder_only_labels` | Inputs with placeholder but no label |
| `DET-003` | `buttons_missing_text > 0` | Buttons with no text, aria-label, or title |
| `DET-004` | `!has_h1` | No H1 on page |
| `DET-005` | `multiple_h1` | More than one H1 |
| `DET-006` | `skipped_heading_level` | H3 present without H2 |
| `DET-007` | `meta_description_length < 50` | Missing/short meta description |
| `DET-008` | `title_length < 10` | Missing/short page title |
| `DET-009` | checkout page + no trust badges + no SSL text | Trust signals absent |
| `DET-010` | checkout page + no progress indicator | No stepper/progress bar |
| `DET-011/015` | checkout page + no guest checkout | No "continue without account" text |
| `DET-012` | product/category page + no breadcrumbs | No breadcrumb nav |
| `DET-013` | homepage + no search bar | No search input |
| `DET-014` | `has_multiple_primary_ctas` | >2 primary CTA buttons |
| `DET-017` | `has_disabled_cta_no_hint` | Disabled button with no error hint |
| `UX-052` | checkout + no progress indicator | Maps to library ID |
| `UX-040` | checkout/cart + no trust/SSL | Maps to library ID |
| `UX-036` | checkout + no guest checkout | Maps to library ID |
| `UX-038` | checkout/product + form present + no inline errors | Maps to library ID |

Confidence is always **1.0** — these are facts, not inferences.

---

### `src/lib/signalMatch.ts` — Keyword Signal Matching Engine

**Role:** Replaces LLM validation with deterministic term matching. Applied to all retrieved library issues.

**Algorithm:**
1. **Negative signal check first:** For each `negative_signals` entry, tokenize into 3+ char words. If ≥50% of terms appear in `crawlText + screenshotOcrText` → **suppress immediately**
2. **Positive signal matching:** For each `signals_to_detect` entry, check ≥50% term overlap in the combined evidence text. Count how many signals match.
3. **Score** = `matchedSignals / totalSignals`
4. **Absence issues** (`detection_type === "absence"`): Included at score 0.8 if page type is confirmed AND feature is missing (score === 0)
5. **Presence issues** with score === 0 → suppressed

---

### `src/lib/ux.ts` — Core Library: Issue Loading, Retrieval, Scoring, LLM Passes

The largest file (~1459 lines). Contains:

#### Issue Loading
```typescript
loadIssueLibrary()  // Reads ux_issue_library_v4.3_COMPLETE.json, caches in memory
```
Supports array or object-wrapping formats (`issues`, `data`, `items` keys).

#### Site Type Inference (inline version)
```typescript
inferSiteType(url, goal, crawlExcerpts, screenshotText)
```
Lightweight regex heuristics — separate from `siteTypeDetection.ts`'s weighted scoring.

#### Keyword Scoring
```typescript
keywordScore(issue, url, goal, crawlExcerpts, screenshotText)
```
Multi-source token overlap scoring:
- Tokenizes: URL + goal + crawl excerpts + screenshot text
- Matches against: `issue_title + user_problem + recommendation + signals_to_detect + page_type`
- **Stage-Aware Boosters:** +5 if the issue's `page_type` matches the inferred journey stage (checkout/PDP/cart)
- **Synonym Expansion:** Maps e.g. "checkout" ↔ "payment/order/transaction"
- **Priority Bonus:** +0.2 for high-priority funnel pages (checkout, cart, payment)
- **Confidence Bonus:** +0.15 for issues with `confidence_weight ≥ 0.85`

#### Evidence Scoring
```typescript
evidenceScore(issue, crawlExcerpts)
```
For each `signal_to_detect`: extract 3+ char terms, require ≥50% to appear in crawl. Returns `matchedSignals / totalSignals`.

#### `simpleRetrieveIssues()` — Main Retrieval Logic

**Presence Track (default):**
1. Score all applicable issues via `keywordScore()`
2. Keep top 2×topK candidates with score > 0
3. If too few: add high-confidence fallback issues (confidence ≥ 0.75)
4. Evidence filter: combined score = `0.4 × keywordScore + 0.6 × evidenceScore`

**Absence Track:**
- Issues with `detection_type === "absence"` bypass keyword scoring
- Included if inferred page type matches `page_type` AND screenshots/crawl confirm page presence

**Image-Detection Track:**
- Image-detected results (from `imageDetectionPass`) are force-added with `keywordScore = 0.95`
- Always rank first after the combined sort

**Force IDs:**
```typescript
const forceIds = new Set(["UX-038", "UX-005", "UX-075", "UX-035", "UX-051"]);
```
These are always included regardless of scoring (previously hard to detect, high recall value).

#### `imageDetectionPass()` — Vision LLM Pass

**Purpose:** A pre-retrieval LLM call using screenshots to identify visual issues.

**Input:** Screenshot data URLs + compact library summary (100 chars per issue max) + audit goal

**Claude path:**
```
POST https://api.anthropic.com/v1/messages
model: claude-3-haiku-20240307
Content: [text prompt + image blocks]
```

**OpenRouter path:**
```
POST https://openrouter.ai/api/v1/chat/completions
model: openrouter/auto
Content: [text + image_url objects]
```

**LLM prompt instructs it to ONLY flag visual issues:** contrast, blur, layout confusion, icon ambiguity — NOT absence-of-element issues (those are handled by DOM rules).

**Response parsing:** Robust — tries direct JSON parse → markdown code block extraction → individual object recovery via regex.

**Output:** `[{ issue_id, confidence: "high"|"medium", evidence }]` → only high/medium kept

#### `buildCompanyGroundedMessages()` — Prompt Assembly

Calls `buildDynamicSystemPrompt()` + `buildDynamicUserPrompt()` from `prompts.ts`.  
Adds a RAG context block with the full retrieved issue JSON.  
Adds a suppressed issues transparency block (prevents LLM from re-reporting suppressed issues).

#### `validateIssuesWithLLM()` — Legacy (kept but not called in main flow)

Previously validated retrieved issues via a second LLM call. Now **replaced** by `deterministicSignalCheck()` from `signalMatch.ts` for reliability and speed.

---

### `src/lib/prompts.ts` — Dynamic LLM Prompt Builder

**Role:** Generates the system and user prompts entirely from the retrieved library issue data. **Nothing is hardcoded.**

#### `buildDynamicSystemPrompt(context)`

Takes: `{ siteType, retrievedIssues, applicableCount, screenshotCount, url, goal }`

Builds a multi-section system prompt containing:

1. **Site type adaptation rules** — adjusts terminology per site type
2. **Evidence hierarchy** — screenshots > crawl > library inference
3. **Findings rules** — ID format, deduplication, no invented IDs
4. **Issue Library Section** — dynamically rendered issue blocks via `renderIssueBlock()`
5. **Systematic analysis process** — steps: screenshot examination → cross-screenshot validation → confidence assessment
6. **Minimum requirements** — 20-30 high/medium findings, mandatory fields per finding
7. **Quality checklist** — 10 self-review items

#### `renderIssueBlock(issue, idx)`

Renders each issue as a numbered block injected into the system prompt:
```
1. UX-040: Security reassurance missing near payment
   Severity: Critical
   Page Type: checkout, cart
   
   SIGNALS TO DETECT (look for these):
   • trust badge
   • SSL
   • padlock icon
   
   NEGATIVE SIGNALS (if present, issue is NOT applicable):
   • secure checkout
   • 256-bit encryption
   
   Visual Confirmation Required: YES — Must see it directly in screenshots
   User Problem: Users feel anxious entering payment details...
   Recommendation: Add SSL badge...
```

#### `buildDynamicUserPrompt(url, goal, hasScreenshots)`

Short, instruction-focused user-turn prompt. Instructs the LLM to:
- Base findings on evidence only (screenshots first, then crawl)
- Reference library UX-### IDs exclusively
- Label uncertain findings as "Needs verification"
- Cover key conversion paths

---

## 5. Scoring Formula Summary

**Retrieval score (how issues get selected):**
```
keywordScore = token_overlap + stageBoost + synonymBonus + confidenceBonus + priorityBonus
evidenceScore = matched_signals / total_signals
combinedScore = 0.4 × keywordScore + 0.6 × evidenceScore
```

**Signal match (validation gate):**
```
score = matched_positive_signals / total_positive_signals
suppress if score = 0 (presence issue) OR any negative signal ≥50% match
```

**Confidence tiers (in final report):**
- `High` — directly visible in screenshot, all signals matched
- `Medium` — most signals matched, pattern strongly present
- `Low` → moved to "Requires Manual Verification" section

---

## 6. LLM Integration Summary

| Pass | Model | Trigger | Purpose |
|---|---|---|---|
| **Image Detection** | Claude Haiku / OpenRouter Auto | Screenshots uploaded | Visual issue identification before retrieval |
| **Main Audit** | Claude Haiku→Sonnet→Opus (fallback) → OpenRouter Auto | Always | Full UX audit report generation |
| ~~Validation~~ | ~~LLM~~ | ~~Replaced~~ | Replaced by `deterministicSignalCheck()` |

**API keys required:**
- `CLAUDE_API_KEY` — Claude direct access (preferred)
- `OPENROUTER_API_KEY` — OpenRouter fallback
- At least one must be set; tool returns a sample report if neither is configured

---

## 7. Frontend (`src/app/page.tsx`)

Single React page (~37KB). Key capabilities:
- URL + goal input form
- Screenshot drag-and-drop upload (up to 6 files)
- Mode toggle: Company Library mode vs. Generic UX mode
- Real-time report rendering (markdown)
- Issue badge sidebar: retrieved issues, deterministic issues, suppressed issues
- Site type badge (ecommerce / SaaS / real estate / etc.)
- Export buttons (report text copy)

---

## 8. Key Design Decisions

| Decision | Why |
|---|---|
| Deterministic rules before LLM | Eliminates false positives on objective checks (alt text, heading structure, etc.) |
| Two-track retrieval (presence + absence) | Absence issues can't be detected by keyword matching — need page-type inference |
| Image detection BEFORE retrieval | Vision-confirmed issues bypass topK cuts and keyword scoring gaps |
| Negative signals suppressed pre-LLM | Prevents LLM from imagining issues that are clearly not applicable |
| Dynamic prompts (no hardcoded IDs) | Library can be updated without touching prompt logic |
| Playwright as fallback | Handles JS-rendered SPAs that block static fetch |
| Force IDs (`UX-038` etc.) | Specific high-value issues historically missed by keyword scoring |
| Report text deduplication | LLM often repeats findings in different sections; post-process removes duplicates |

---

## 9. Data Flow Diagram

```
User Input (URL + Goal + Screenshots)
          │
          ▼
  crawlKeyPaths [crawl.ts]              ←── If JS-render: crawlWebsite [crawlPlaywright.ts]
          │
          ▼
  extractPageExcerpt → crawlContext     ←── runDomChecks → DomChecks flags
          │                                      │
          │                                      ▼
          │                           runDeterministicDetection [detect.ts]
          │                                      │
          │                              deterministicIssues[]
          │
          ▼
  detectSiteType [siteTypeDetection.ts]
          │
          ▼
  filterApplicableIssues
          │
          ├──► If screenshots: imageDetectionPass [ux.ts] → imageDetectedResults[]
          │                           (Vision LLM call)
          ▼
  simpleRetrieveIssues [ux.ts]
  (keyword scoring + evidence scoring + absence track + image-detected force-include)
          │
          ▼
  deterministicSignalCheck [signalMatch.ts] for each retrieved issue
          │
          ├── suppressed[]
          └── validated[]
                    │
                    ▼
  buildCompanyGroundedMessages → buildDynamicSystemPrompt + buildDynamicUserPrompt [prompts.ts]
                    │
                    ▼
  Main LLM Call (Claude or OpenRouter)
                    │
                    ▼
          dedupeReportText()
                    │
                    ▼
  JSON Response → Frontend Render
```
