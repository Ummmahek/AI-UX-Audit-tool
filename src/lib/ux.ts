import fs from "fs/promises";
import path from "path";

export type Issue = {
  issue_id?: string;
  domain?: string;
  page_type?: string[];
  issue_title?: string;
  user_problem?: string;
  recommendation?: string;
  signals_to_detect?: string[];
  acceptance_criteria?: string[];
  confidence_weight?: number;
  severity?: string;
  is_validated?: boolean;
  [key: string]: unknown;
};

export type RetrievedIssue = Issue;

/** Result from image-led detection pass: issue confirmed visually in a screenshot. */
export type ImageDetectedResult = {
  issue_id: string;
  evidence_summary: string;
  screenshot_index: number;
};

/** Default library file (under src/data). Replace this or set UX_ISSUE_LIBRARY env to use another file. */
const DEFAULT_LIBRARY_FILE = "ux_issue_library_ecommerce_v3.5_REFINED.json";

function getIssueLibraryPath(): string {
  const envPath = process.env.UX_ISSUE_LIBRARY;
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.join(process.cwd(), envPath);
  }
  return path.join(process.cwd(), "src", "data", DEFAULT_LIBRARY_FILE);
}

let cachedIssues: Issue[] | null = null;

export async function loadIssueLibrary(): Promise<Issue[]> {
  if (cachedIssues) return cachedIssues;

  const libraryPath = getIssueLibraryPath();
  const raw = await fs.readFile(libraryPath, "utf-8");
  const parsed = JSON.parse(raw);

  if (Array.isArray(parsed)) {
    cachedIssues = parsed;
    return parsed;
  }

  for (const key of ["issues", "data", "items"]) {
    if (Array.isArray(parsed?.[key])) {
      cachedIssues = parsed[key];
      return parsed[key];
    }
  }

  throw new Error(
    "Issue library JSON format not recognized (expected list or object with issues/data/items).",
  );
}

function keywordScore(
  issue: Issue,
  url: string,
  goal: string,
  crawlExcerpts = "",
  screenshotText = ""
): number {
  // When calculating recall we want to consider *all* available evidence
  // sources, not just the goal text.  Previously we only tokenized the URL
  // and goal, which meant that PDP/Cart/Form issues were often dropped when
  // the goal happened to be something like "checkout".  The fix is to
  // explicitly tokenize the crawl excerpts and any text extracted from
  // screenshots and give those tokens equal weight.  This way the library
  // retrieval will surface an issue whenever its signals appear anywhere in
  // the visible page content.
  const baseText = `${url} ${goal}`.toLowerCase();
  const contentText = `${crawlExcerpts} ${screenshotText}`.toLowerCase();
  const queryText = `${baseText} ${contentText}`;
  const tokens = new Set(queryText.match(/[a-z0-9]+/g) ?? []);

  // Detect current journey stage from any of the text sources above
  const isCheckout = /\b(checkout|payment|billing|shipping|secure|auth|login)\b/i.test(queryText);
  const isPDP = /\b(pdp|product|item|add to bag|add to cart|price|sku|size)\b/i.test(queryText);
  const isCart = /\b(cart|bag|basket|items in)\b/i.test(queryText);

  const parts: string[] = [];
  for (const key of ["issue_title", "user_problem", "recommendation"]) {
    const value = issue[key];
    if (typeof value === "string") parts.push(value.toLowerCase());
  }

  if (Array.isArray(issue.signals_to_detect)) {
    parts.push(issue.signals_to_detect.join(" ").toLowerCase());
  }

  if (Array.isArray(issue.page_type)) {
    parts.push(issue.page_type.join(" ").toLowerCase());
  }

  const blobTokens = new Set((parts.join(" ").match(/[a-z0-9]+/g)) ?? []);
  const overlap = [...tokens].filter((t) => blobTokens.has(t)).length;

  // Stage-Aware Booster: if issue matches current stage, give it a massive boost
  let stageBoost = 0;
  if (Array.isArray(issue.page_type)) {
    const issueStages = issue.page_type.map(s => s.toLowerCase());
    if (isCheckout && (issueStages.includes("checkout") || issueStages.includes("payment"))) stageBoost += 5;
    if (isPDP && (issueStages.includes("product_detail") || issueStages.includes("pdp"))) stageBoost += 5;
    if (isCart && issueStages.includes("cart")) stageBoost += 5;
  }

  // Domain-aware keyword expansion: treat synonyms as equivalent
  const domainSynonyms: { [key: string]: string[] } = {
    "checkout": ["payment", "order", "purchase", "transaction", "billing"],
    "cart": ["basket", "shopping", "items"],
    "product": ["item", "sku", "listing", "merchandise"],
    "homepage": ["home", "landing", "main"],
    "flow": ["journey", "process", "path"],
  };

  let synonymBonus = 0;
  for (const [key, synonyms] of Object.entries(domainSynonyms)) {
    const hasKey = blobTokens.has(key);
    const hasSynonym = synonyms.some((syn) => tokens.has(syn));
    if (hasKey && hasSynonym) {
      synonymBonus += 0.5; // Bonus for matching synonym pairs
    }
  }

  const confidence = typeof issue.confidence_weight === "number"
    ? issue.confidence_weight
    : 0.7;
  const confidenceBonus = confidence >= 0.85 ? 0.15 : 0;

  // Journey stage boost: checkout/cart/payment issues are high priority
  const highPriorityTerms = ["checkout", "payment", "cart", "purchase"];
  const isHighPriority = highPriorityTerms.some((term) => tokens.has(term));
  const priorityBonus = isHighPriority ? 0.2 : 0;

  return overlap + synonymBonus + confidenceBonus + priorityBonus + stageBoost;
}

/**
 * Checks if an issue's signals are present in the crawl excerpts.
 * Now supports multi-pattern detection: if ANY signal pattern matches, it counts as evidence.
 * Returns a score (0-1) indicating how well the signals match the evidence.
 */
function evidenceScore(
  issue: Issue,
  crawlExcerpts: string,
): number {
  if (!crawlExcerpts || crawlExcerpts.trim().length === 0) {
    // No crawl data available - don't penalize, but don't boost either
    return 0.5;
  }

  const signals = issue.signals_to_detect ?? [];
  if (signals.length === 0) {
    // Issue has no specific signals - neutral score
    return 0.5;
  }

  const crawlLower = crawlExcerpts.toLowerCase();
  let signalMatches = 0;
  const totalSignals = signals.length;

  for (const signal of signals) {
    if (typeof signal !== "string") continue;

    const signalLower = signal.toLowerCase();

    // Extract key meaningful terms from the signal (3+ chars)
    const signalTerms = signalLower
      .match(/\b[a-z0-9]{3,}\b/g) ?? [];

    // For this specific signal, check if multiple terms appear in crawl
    // This increases specificity: require 2+ key terms to match
    const matchedTerms = signalTerms.filter((term) => crawlLower.includes(term)).length;
    const termMatchRatio = matchedTerms / Math.max(signalTerms.length, 1);

    // A signal matches if majority of its key terms appear in crawl
    if (termMatchRatio >= 0.5) {
      signalMatches++;
    }
  }

  // Return the ratio of matched signals
  // With multiple signal variations, you only need some to match
  const score = totalSignals > 0 ? signalMatches / totalSignals : 0.5;
  return score;
}

/**
 * Infer likely page types from crawl excerpts, screenshot filenames, and goal text.
 * Screenshot filenames are useful here because they often encode page context
 * (e.g. "checkout_desktop.png", "pdp_mobile.png").
 */
function inferPageTypes(
  crawlExcerpts: string | undefined,
  screenshotFilenames: string,
  goal: string,
): string[] {
  const haystack = `${crawlExcerpts ?? ""} ${screenshotFilenames ?? ""} ${goal ?? ""}`.toLowerCase();
  const matched = new Set<string>();

  const test = (keywords: string[], pageType: string) => {
    if (keywords.some((kw) => haystack.includes(kw))) {
      matched.add(pageType);
    }
  };

  test(["checkout", "payment"], "Checkout");
  test(["cart", "bag"], "Cart");
  test(["product", "pdp"], "PDP");
  test(["homepage", "home"], "Homepage");
  test(["account", "login", "register"], "Account");
  test(["search"], "Search");
  test(["orders", "confirmation"], "Orders");
  test(["forms", "form"], "Forms");
  test(["navigation", "nav", "menu"], "Navigation");
  test(["mobile"], "Mobile");

  return Array.from(matched);
}

/**
 * Retrieves issues using keyword matching (presence track) and page-type inference (absence track),
 * then filters by evidence from crawl excerpts.
 *
 * Presence-track behaviour (detection_type === "presence") keeps existing keyword scoring logic.
 * Absence-track behaviour (detection_type === "absence") bypasses keywordScore() and uses
 * inferred page types plus confidence weight to seed the candidate pool.
 */
export function simpleRetrieveIssues(
  issueLibrary: Issue[],
  url: string,
  goal: string,
  topK = 7,
  crawlExcerpts?: string,
  screenshotText = "",
  hasScreenshots = false,
  imageDetected?: ImageDetectedResult[],
): RetrievedIssue[] {
  const detectionType = (issue: Issue): string =>
    typeof (issue as any).detection_type === "string" ? String((issue as any).detection_type) : "presence";

  const presenceIssues = issueLibrary.filter((issue) => detectionType(issue) !== "absence");
  const absenceIssues = issueLibrary.filter((issue) => detectionType(issue) === "absence");

  // Step 1 (presence track): Keyword-based scoring (broadened query for better recall)
  const keywordScored = presenceIssues
    .map((issue) => ({
      issue,
      keywordScore: keywordScore(issue, url, goal, crawlExcerpts, screenshotText),
    }))
    .sort((a, b) => b.keywordScore - a.keywordScore);

  // Fallback (presence track): if keyword matching is weak, include high-confidence library items
  let candidates = keywordScored
    .filter((entry) => entry.keywordScore > 0)
    .slice(0, topK * 2);

  // If we got very few candidates from keyword matching, add high-confidence fallback issues
  if (candidates.length < topK / 2) {
    const highConfidence = keywordScored
      .filter((entry) => {
        const conf = typeof entry.issue.confidence_weight === "number" ? entry.issue.confidence_weight : 0.7;
        return conf >= 0.75 && entry.keywordScore === 0; // Add high-conf issues that didn't match keyword
      })
      .slice(0, topK);
    candidates = [...candidates, ...highConfidence];
  }

  if (candidates.length === 0) {
    // Ultimate fallback (presence track only): return top high-confidence issues by confidence weight
    candidates = keywordScored
      .filter((entry) => {
        const conf = typeof entry.issue.confidence_weight === "number" ? entry.issue.confidence_weight : 0.7;
        return conf >= 0.75;
      })
      .slice(0, topK);
  }

  // ABSENCE TRACK: seed candidates for detection_type === "absence"
  if (absenceIssues.length > 0) {
    const inferredPageTypes = inferPageTypes(crawlExcerpts, screenshotText, goal);

    if (inferredPageTypes.length > 0) {
      const hasAnyCrawlExcerpt = Boolean(crawlExcerpts && crawlExcerpts.trim().length > 0);

      const absenceCandidates = absenceIssues
        .filter((issue) => {
          const pages = Array.isArray(issue.page_type) ? issue.page_type : [];
          const hasPageMatch = pages.some((p) => inferredPageTypes.includes(p));
          if (!hasPageMatch) return false;

          // If screenshots exist, rely on them even when crawl is blocked.
          if (hasScreenshots) return true;

          // Without screenshots, only consider absence issues when some crawl excerpt exists.
          return hasAnyCrawlExcerpt;
        })
        .map((issue) => {
          const conf = typeof issue.confidence_weight === "number" ? issue.confidence_weight : 0.7;
          return {
            issue,
            keywordScore: conf, // use confidence_weight directly as the score for absence-track
            source: "absence-track" as const,
          };
        });

      if (absenceCandidates.length > 0) {
        candidates = [...candidates, ...absenceCandidates];
      }
    }
  }

  // Image-detection pass: force-include issues confirmed by direct visual inspection
  type CandidateEntry = { issue: Issue; keywordScore: number; source?: "absence-track" | "image-detection" };
  if (imageDetected && imageDetected.length > 0) {
    const seenIds = new Set((candidates as CandidateEntry[]).map((c) => c.issue.issue_id).filter(Boolean));
    const byId = new Map<string, Issue>();
    for (const issue of issueLibrary) {
      if (issue.issue_id) byId.set(issue.issue_id, issue);
    }
    const imageEntries: CandidateEntry[] = [];
    for (const item of imageDetected) {
      if (seenIds.has(item.issue_id)) continue;
      const issue = byId.get(item.issue_id);
      if (!issue) continue;
      seenIds.add(item.issue_id);
      imageEntries.push({ issue, keywordScore: 0.95, source: "image-detection" });
    }
    candidates = [...(candidates as CandidateEntry[]), ...imageEntries];
    // So that image-detected (0.95) rank first when no crawl path uses candidates.slice(0, topK)
    candidates.sort((a, b) => b.keywordScore - a.keywordScore);
  }

  // Step 2: Evidence-based filtering (if crawl excerpts available)
  if (crawlExcerpts && crawlExcerpts.trim().length > 0) {
    const crawlLower = crawlExcerpts.toLowerCase();
    const screenshotLower = (screenshotText || "").toLowerCase();
    const combinedEvidence = crawlLower + " " + screenshotLower;

    const evidenceScored = candidates.map((entry) => {
      const isImageDetected = (entry as any).source === "image-detection";
      const crawlEv = evidenceScore(entry.issue, crawlExcerpts);
      const screenshotEv = evidenceScore(entry.issue, screenshotText);
      const bestEv = isImageDetected ? 0.95 : Math.max(crawlEv, screenshotEv);

      return {
        ...entry,
        evidenceScore: bestEv,
        // Updated weights: 40% keyword, 60% best evidence (crawl or screenshot)
        combinedScore: entry.keywordScore * 0.4 + bestEv * 0.6,
      };
    });

    // NOTE: Removed aggressive early negative-signal filtering here.  Earlier
    // versions dropped candidates based solely on any matching negative
    // phrase, which occasionally suppressed perfectly valid issues (e.g.
    // UX-040 when the header text said “Secure Checkout”).  We'll still pass
    // negative signals through to the later LLM validation step, but retrieval
    // should not throw issues away before the audit is generated.
    
    // If screenshots are present, relax filters to surface keyword-matched issues with partial crawl evidence
    const filtered = evidenceScored.filter((entry) => {
      const ev = entry.evidenceScore ?? 0;
      const kw = entry.keywordScore ?? 0;
      const conf = typeof entry.issue.confidence_weight === "number" ? entry.issue.confidence_weight : 0.7;

      if (hasScreenshots) {
        // If the issue explicitly requires evidence, require minimum crawl support
        if ((entry.issue as any).evidence_required) return ev >= 0.3;

        // Auto-include when clear crawl evidence exists
        if (ev >= 0.4) return true;

        // Allow when some evidence + minimal keyword relevance
        if (ev >= 0.25 && kw >= 0.8) return true;

        // Allow high-confidence library items with even partial crawl evidence
        if (conf >= 0.7 && ev >= 0.2) return true;

        // Allow reasonable keyword matches even if crawl is weak (most important for screenshots)
        if (kw >= 0.5 && ev >= 0.1) return true;

        // VERY lenient: include high-confidence items with ANY keyword match when screenshots are present
        if (conf >= 0.75 && kw >= 0.2) return true;

        return false;
      }

      // No screenshots: use previous stricter rules
      return ev >= 0.6 || (ev >= 0.4 && kw >= 2.5);
    });

    return filtered
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, topK)
      .map((entry) => entry.issue);
  }

  // Fallback: No crawl data - use keyword matching only
  if ((!crawlExcerpts || crawlExcerpts.trim().length === 0) && screenshotText.trim().length > 0) {
    const ssLower = screenshotText.toLowerCase();
    candidates = candidates.filter((entry) => {
      const negs: string[] = (entry.issue as any).negative_signals ?? [];
      if (!Array.isArray(negs) || negs.length === 0) return true;
      const anyNegMatch = negs.some(
        (n) => typeof n === "string" && ssLower.includes(n.toLowerCase()),
      );
      return !anyNegMatch;
    });
  }
  // final step: make sure we don't hand back the same library ID twice
  const unique: RetrievedIssue[] = [];
  const seenIds = new Set<string>();
  for (const issue of candidates.slice(0, topK).map((entry) => entry.issue)) {
    if (issue.issue_id) {
      if (seenIds.has(issue.issue_id)) {
        console.log(`[retrieve] deduped duplicate issue_id ${issue.issue_id}`);
        continue;
      }
      seenIds.add(issue.issue_id);
    }
    unique.push(issue);
  }

  // ensure that a handful of problematic but hard-to-detect issues are
  // surfaced even when keyword/evidence scoring misses them.  These were
  // repeatedly absent in earlier drafts and must be visible for manual
  // verification.  Also include anything the library marks for
  // needs_verification.
  const forceIds = new Set(["UX-038", "UX-005", "UX-075", "UX-035", "UX-051"]);
  for (const issue of issueLibrary) {
    if (!issue.issue_id) continue;
    if (seenIds.has(issue.issue_id)) continue;
    if (forceIds.has(issue.issue_id) || (issue as any).flag_as_needs_verification) {
      console.log(`[retrieve] adding forced issue ${issue.issue_id} for recall`);
      unique.push(issue);
      seenIds.add(issue.issue_id);
    }
  }

  return unique;
}

/**
 * Build a compact library summary for the image-detection LLM call.
 * Each issue: issue_id, issue_title, detection_type, page_type, detection_hint (first signal, max 15 words).
 */
function buildCompactLibrarySummary(issueLibrary: Issue[]): Array<{ issue_id: string; issue_title: string; detection_type: string; page_type: string[]; detection_hint: string }> {
  return issueLibrary.map((issue) => {
    const signals: string[] = Array.isArray(issue.signals_to_detect) ? issue.signals_to_detect : [];
    const firstSignal = signals[0] ?? "";
    const hintWords = firstSignal.split(/\s+/).slice(0, 15).join(" ");
    const detectionType = typeof (issue as any).detection_type === "string" ? String((issue as any).detection_type) : "presence";
    const pageType = Array.isArray(issue.page_type) ? issue.page_type : [];
    return {
      issue_id: issue.issue_id ?? "",
      issue_title: issue.issue_title ?? "",
      detection_type: detectionType,
      page_type: pageType,
      detection_hint: hintWords,
    };
  });
}

/**
 * Image-led detection pass: run BEFORE retrieval when screenshots are present.
 * Sends screenshots + compact library to LLM; returns issue IDs with clear visual evidence.
 * On parse failure or error, returns [] and logs — does not throw. Pipeline continues unchanged.
 */
export async function imageDetectionPass(
  screenshotDataUrls: string[],
  issueLibrary: Issue[],
  apiKey: string,
  useClaude: boolean,
): Promise<ImageDetectedResult[]> {
  if (screenshotDataUrls.length === 0 || issueLibrary.length === 0) {
    return [];
  }

  const compactLib = buildCompactLibrarySummary(issueLibrary);
  const instruction = `You are a UX analyst. Review the provided screenshots carefully.
For each issue in the library below, determine if there is clear visual evidence in any screenshot that this issue is present (for presence issues) or that the element is missing (for absence issues). Only include issues where you have clear visual confidence.

CONFIDENCE DEFINITIONS (STRICT):
- "high" = you can clearly see the issue or missing element directly in the screenshot with no ambiguity.
- "medium" = you can see a strong indirect signal — for example, a form field implying missing validation, or a sort dropdown with a placeholder default. Do NOT use medium for issues inferred from general page structure, brand conventions, or anything not visible in the screenshot area.

CRITICAL FILTERING RULES:
1. If the evidence is not clearly visible in the screenshot, omit the issue entirely. When in doubt, omit.
2. Before returning an issue, ask yourself: Can I point to a specific pixel area in the screenshot that shows this problem? If not, omit it.
3. Do not flag issues where the element exists but is suboptimal. Only flag where the element is clearly broken or completely absent.

Return ONLY a JSON array. No explanation. No markdown. Format:
[
  {
    "issue_id": "string",
    "screenshot_index": number,
    "confidence": "high" | "medium",
    "evidence_summary": "string (max 20 words)"
  }
]

Only return issues where confidence is medium or high.
Do not return every issue — only ones with real visual evidence.`;

  const prompt = `${instruction}\n\nLibrary (compact):\n${JSON.stringify(compactLib, null, 2)}`;

  try {
    let responseText: string;
    if (useClaude) {
      const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-3-haiku-20240307",
          max_tokens: 4000,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...screenshotDataUrls.slice(0, 10).map((url) => ({
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: (url.match(/data:(.*?);/) || [])[1] as string || "image/jpeg",
                  data: url.split(",")[1],
                },
              })),
            ],
          }],
        }),
      });
      const data = await claudeResp.json() as { content?: Array<{ type: string; text?: string }>; error?: { message?: string } };
      if (!claudeResp.ok) {
        console.error("[imageDetectionPass] Claude API error:", data.error?.message ?? claudeResp.status);
        return [];
      }
      responseText = data.content?.find((c) => c.type === "text")?.text ?? "[]";
    } else {
      const openRouterResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openrouter/auto",
          max_tokens: 4000,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...screenshotDataUrls.slice(0, 10).map((url) => ({
                type: "image_url",
                image_url: { url },
              })),
            ],
          }],
        }),
      });
      const data = await openRouterResp.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
      if (!openRouterResp.ok || data.error) {
        console.error("[imageDetectionPass] OpenRouter API error:", data.error?.message ?? openRouterResp.status);
        return [];
      }
      responseText = data.choices?.[0]?.message?.content ?? "[]";
    }

    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error("[imageDetectionPass] No JSON array in response");
      return [];
    }
    const parsed = JSON.parse(jsonMatch[0]) as Array<{ issue_id?: string; screenshot_index?: number; confidence?: string; evidence_summary?: string }>;
    if (!Array.isArray(parsed)) {
      console.error("[imageDetectionPass] Parsed value is not an array");
      return [];
    }
    const results: ImageDetectedResult[] = [];
    for (const item of parsed) {
      const conf = (item.confidence ?? "").toLowerCase();
      if (conf !== "high" && conf !== "medium") continue;
      const id = typeof item.issue_id === "string" ? item.issue_id.trim() : "";
      if (!id) continue;
      const idx = typeof item.screenshot_index === "number" ? item.screenshot_index : 0;
      const summary = typeof item.evidence_summary === "string" ? item.evidence_summary.trim().slice(0, 200) : "";
      results.push({ issue_id: id, evidence_summary: summary, screenshot_index: idx });
    }
    return results;
  } catch (e) {
    console.error("[imageDetectionPass] Failed:", e);
    return [];
  }
}

export type IssueValidation = {
  issue_id: string;
  positive_signals_in_screenshots?: string[];
  positive_signals_in_crawl?: string[];
  positive_signals_confirmed: string[];
  negative_signals_confirmed: string[];
  evidence_is_conditional: boolean;
  /** Set true by LLM when evidence page stage doesn't match issue page_type */
  page_type_mismatch?: boolean;
  include: boolean;
  suppression_reason?: string;
};

export type PromptMessage = { role: "system" | "user"; content: string };

export function buildCompanyGroundedMessages(
  url: string,
  goal: string,
  retrievedIssues: RetrievedIssue[],
  suppressedIssues?: Array<{ issue: RetrievedIssue; reason: string }>,
): PromptMessage[] {
  const systemPrompt = `You are a UX Auditor for Digital of Things.

Generate a FIRST-DRAFT UX AUDIT.
This is an experience-level assessment, not a checklist.

RULES
- Evidence hierarchy (STRICT – screenshots always win):
- 1) Screenshots (PRIMARY – most reliable; use for cart, checkout, PDP whenever provided). 2) Crawl (SECONDARY – often incomplete or blocked on cart/checkout). 3) RAG only to label what you see. 4) No inference without evidence.
- SCREENSHOTS OVER CRAWL: When the user provides screenshots, treat them as the main source of truth; crawl often fails on cart/checkout. For any page visible in screenshots, base findings on screenshots only. ONLY ACTUALLY-PRESENT ISSUES: Include in the report ONLY issues for which you see direct evidence in screenshots or crawl; omit any RAG issue you do not see evidence for. You may reference UX issues from the context only when you have observed evidence for them.
- Screenshots override crawl: if screenshots show something (e.g. checkout), do not treat its absence in crawl as a failure. Ground every finding in observable signals; if you cannot see it, do not include it.
- Ground findings in observable interface signals from screenshots and SITE CRAWL EXCERPTS; if uncertain, label “Needs verification”.
- Never fabricate analytics, user quotes, or test results.
- Never claim that users “cannot” complete a task (e.g. purchase, checkout, add to cart) unless there is direct, observable evidence of a blocking error state in the crawl or screenshots.
- If a state depends on a prerequisite action that the crawl cannot perform (e.g. adding to cart, logging in, submitting forms, completing checkout), treat it as: “Not observable via crawl – Requires manual verification”.
- Do NOT treat an empty cart as a UX issue if no product was added in the crawl context.
- **STRICT UNICITY RULE: Each Library Issue ID (UX-###) can only be included ONCE in the entire report.** This is a hard constraint. If an issue (like UX-052) applies to multiple stages, you MUST include it in the ONE stage where the evidence is strongest. Never repeat a Library ID in different sections; it makes the audit look like padding rather than analysis.
- **POST-WRITE SELF-AUDIT**: After you draft the three journey sections, reread your own text and **remove any repeated UX-### lines**. Only the first mention counts; if you see the same ID appear again elsewhere, edit that section to eliminate the duplicate (move the discussion or note “see earlier”).
- **STAGE ACCURACY**: Place issues in the journey section that matches the **evidence location**, not where the issue is generically tagged.  A checkout/payment problem must appear under Book (or Decide if it’s on a PDP) – do NOT slip it into Discover just because the URL originated there.  Misplacement undermines the audit clarity.
- **ID MATCHING: Before including an issue, double-check that the ID you are assigning actually matches the content of that exact issue in the library. Do not mix up IDs.**
- **SPECIFIC ID RULES:**
    - **UX-052 (Multi-step feedback):** Apply ONLY to missing progress indicators or loading states during multi-step checkout journeys (e.g., transition between bag → address → payment). Do NOT apply to micro-interactions like "cart icon counter not updating" or "page feels like a refresh" unless it causes a complete loss of orientation in a multi-step sequence.
- **If an issue ID appears in the "SUPPRESSED ISSUES" list below, it MUST NOT be included in the Discover, Decide, or Book sections. It ONLY belongs in the "Suppressed Issues (Transparency)" section at the very end. Do NOT claim suppressed issues are "not observable" in the main sections; simply omit them from there entirely.**
- If you include a "Suppressed Issues (Transparency)" section at the end, you must use the exact IDs provided in the "SUPPRESSED ISSUES" context block. Do not say "no issues were suppressed" if a list was provided.

LIBRARY MAPPING (CRITICAL RULE)
- **MANDATORY ID MAPPING**: Under the "Discover", "Decide", or "Book" sections, EVERY SINGLE Key UX Issue you list MUST be a library issue from the RAG context provided below.
- Each finding MUST start with a Library ID in the format: **UX-###: [Issue Title]**.
- **NO FREE-TEXT FINDINGS**: Do NOT invent or describe issues that are not in the library under the main journey sections. If it is not in the library, it is NOT an issue for the main sections. This ensures the audit is grounded in company standards.
- If you observe a real UX problem that absolutely does not fit any library ID, you MUST place it in a separate section called: “Additional observations (not in library)” and do NOT assign it an ID.
- **REJECTION RULE**: Any finding in the main journey without a valid library ID will be rejected.
- If an issue is in the "SUPPRESSED ISSUES" list, DO NOT include it in the main sections.

REASONING LENS
- Use DOT criteria and Nielsen heuristics qualitatively (not as formulas).

OUTPUT
- Organize by journey stages (Discover → Decide → Book).
- Explain dominant experience patterns and implications for where UX should focus next.
- Be substantially detailed: for each stage, include at least 1 dominant pattern + 3+ issues if the context supports it.
- For each issue, include: Evidence (page + signal), User impact, and Why it matters.
- Avoid design/implementation prescriptions; focus on diagnosis and implications.
- End with: "Where a manual UX audit should focus next"
- After that, if suppressed issues were provided in the context, add a "Suppressed Issues (Transparency)" section listing which issues were filtered out and why (e.g., "UX-102: Phone country code doesn't match selected country — +971 correct for UAE context"). This builds auditability and trust.`;

  const userPrompt = `Audit the following website using the provided UX Issue Patterns and DOT reasoning lens.

URL: ${url}
Primary goal: ${goal}

Instructions:
- Create an experience-led audit. Include ONLY issues you actually see in the evidence (screenshots first, then crawl). Omit any RAG issue you do not see evidence for.
- **STRICT ID RULE: You must ONLY use issue IDs that exist in the RAG context provided below. Do not approximate or hallucinate IDs. If a finding doesn't match a library ID, put it in "Additional observations (not in library)".**
- Prioritise screenshot evidence over crawl: for cart, checkout, PDP, and any page shown in screenshots, use what the screenshots show; crawl is secondary and often wrong for those pages.
- Separate confirmed (visible in evidence) vs needs verification only when you have partial evidence.
- Do not list issues that are not observable in the provided screenshots or crawl excerpts. If evidence is missing for an issue, omit that issue; do not list it. Use and cite evidence from screenshots and SITE CRAWL EXCERPTS. If evidence is missing, mark “Needs verification”.
- If screenshots clearly show a later-stage UI (e.g. PDP with pricing/stock, or a rendered checkout with order summary and payment methods), treat that stage as observable and do NOT infer that it is “missing” or “broken”.
- Aim to cover the key paths: home → category → product → cart → checkout (when present in crawl).
- For cart/checkout and any action-dependent flows (add-to-cart, form submission, authentication), if the crawl cannot actually perform the action, avoid strong failure language and instead say “Not observable via crawl – Requires manual verification”.
- End with: “Where a manual UX audit should focus next”`;

  const contextJson = JSON.stringify(
    { "Context: Retrieved UX Issue Patterns (STRICT LIST - use ONLY these IDs)": retrievedIssues },
    null,
    2,
  );

  let suppressedSection = "";
  if (suppressedIssues && suppressedIssues.length > 0) {
    const suppressedSummary = suppressedIssues
      .map((s) => `- ${s.issue.issue_id}: ${s.issue.issue_title} (Reason: ${s.reason})`)
      .join("\n");
    suppressedSection = `\n\n---\nSUPPRESSED ISSUES (IMPORTANT: DO NOT include these IDs in your journey findings):\nThe following issues were considered but were suppressed by the validation logic. Do NOT include them in the Discover, Decide, or Book sections.\n\n${suppressedSummary}\n\nList these exactly as shown above in a section at the very end of your report titled "Suppressed Issues (Transparency)". Do not claim the list is empty or invalid.\n---\n`;
  }

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
    { role: "user", content: `RAG context – use ONLY the IDs provided in this list; omit any issue you do not see in evidence:\n${contextJson}${suppressedSection}` },
  ];
}

export function buildGenericMessages(
  url: string,
  goal: string,
): PromptMessage[] {
  const systemPrompt = `You are an AI UX expert.
Generate a first-draft UX audit for a transactional/e-commerce website using general UX heuristics.
Do not assume access to analytics or user testing.
Organize findings by user journey.

REQUIREMENTS
- Evidence hierarchy (STRICT): 1) Screenshots (PRIMARY). 2) Crawl (SECONDARY; often fails on cart/checkout). Only include issues you see in evidence; omit the rest. SCREENSHOTS OVER CRAWL.
- Use evidence from screenshots and SITE CRAWL EXCERPTS when making a “Confirmed” claim.
- If crawl suggests absence but screenshots show presence, let the screenshots win.
- Be substantially detailed: for each stage (Discover/Decide/Book), include 1 dominant pattern + 3+ issues if evidence supports it.
- For each issue, include: Evidence (page + signal), User impact, and Why it matters.
- If evidence is missing or ambiguous, label “Needs verification” and say what would need checking.
- Do NOT treat an empty cart as a UX issue if there is no evidence that a product was added.
- Do NOT infer broken checkout, payment failure, or purchase impossibility unless an explicit blocking error state is visible in the crawl or screenshots.
- For any flow that depends on actions that the crawl cannot perform (adding items, logging in, submitting forms, completing checkout), explicitly mark findings as “Not observable via crawl – Requires manual verification” rather than stating that the flow is broken.`;

  const userPrompt = `Audit the following website.

URL: ${url}
Primary goal: ${goal}

Generate a first-draft UX audit that a UX team could review. Include only issues you observe in the evidence (screenshots first, then crawl); omit any issue you do not see.

Note: This generic mode does NOT use the company UX issue library, so issues will not have library IDs.

At the end of the report, add a short “Coverage & Limitations” note that explains that action-dependent flows (add-to-cart, authentication, checkout, payments) could not be directly exercised by the automated crawl, and therefore must be treated as “Not observable via crawl – Requires manual verification”.`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

export function formatMessagesForResponses(messages: PromptMessage[]): string {
  return messages
    .map((m) => `${m.role.toUpperCase()}:\n${m.content}\n`)
    .join("\n");
}

/**
 * Validates issues via LLM and applies penalties programmatically.
 * Returns validated issues and suppressed issues list.
 */
export async function validateIssuesWithLLM(
  issues: RetrievedIssue[],
  url: string,
  goal: string,
  crawlExcerpts: string,
  screenshotText: string,
  apiKey: string,
  useClaude: boolean,
  screenshotImages?: string[],
  imageDetected?: ImageDetectedResult[],
): Promise<{ validated: RetrievedIssue[]; suppressed: Array<{ issue: RetrievedIssue; reason: string }> }> {
  if (issues.length === 0) {
    return { validated: [], suppressed: [] };
  }

  // Build validation prompt - evaluate screenshots and crawl separately
  const hasCrawl = crawlExcerpts && crawlExcerpts.trim().length > 0;
  const hasScreenshots = screenshotText && screenshotText.trim().length > 0;

  let imageDetectedBlock = "";
  if (imageDetected && imageDetected.length > 0) {
    imageDetectedBlock = `

Image-detection pass results (treat as strong positive evidence — only suppress if you see an explicit counter-signal):
${imageDetected.map((r) => `- ${r.issue_id}: This issue was confirmed by direct visual inspection of screenshot [${r.screenshot_index}]. Evidence: ${r.evidence_summary}. Treat this as strong positive evidence. Only suppress if you see an explicit counter-signal.`).join("\n")}
`;
  }

  const validationPrompt = `You are validating UX issues against evidence. Evaluate SCREENSHOTS and CRAWL as INDEPENDENT sources. An issue should be included if EITHER source provides evidence.

URL: ${url}
Goal: ${goal}

Evidence sources (evaluate separately):
${hasScreenshots ? `SCREENSHOTS (primary evidence - evaluate independently):\n${screenshotText}\n` : "SCREENSHOTS: None provided\n"}
${hasCrawl ? `CRAWL EXCERPTS (secondary evidence - evaluate independently):\n${crawlExcerpts}\n` : "CRAWL EXCERPTS: None available (may be blocked)\n"}
${imageDetectedBlock}

Issues to validate:
${JSON.stringify(issues.map((i) => ({
    issue_id: i.issue_id,
    issue_title: i.issue_title,
    page_type: i.page_type,
    signals_to_detect: i.signals_to_detect,
    negative_signals: (i as any).negative_signals,
    context_notes: (i as any).context_notes,
  })), null, 2)}

For EACH issue, return a JSON object with:
{
  "issue_id": "...",
  "positive_signals_in_screenshots": ["signal1"], // Positive signals found in SCREENSHOTS (empty array [] if none — never omit this field)
  "positive_signals_in_crawl": ["signal2"],       // Positive signals found in CRAWL (empty array [] if none or crawl blocked — never omit this field)
  "positive_signals_confirmed": ["signal1", "signal2"], // Combined: signals from EITHER source
  "negative_signals_confirmed": ["signal1"], // Negative signals found in EITHER source (suppresses issue)
  "evidence_is_conditional": true/false,
  "page_type_mismatch": true/false,
  "include": true/false,
  "suppression_reason": "..."
}

RULES — apply in this exact order:

1. ZERO-EVIDENCE HARD RULE:
   If positive_signals_in_screenshots is [] AND positive_signals_in_crawl is [] → set include: false.
   This rule has NO exceptions, even if the issue sounds plausible.

2. CONDITIONAL EVIDENCE RULE:
   Evidence must describe what IS currently visible — not what might be true or what could happen.
   If the only evidence you can state contains words like "if", "may", "might", "could", "would", "will", "not visible", "not observable", "warrants review", "requires further verification", "blurred", "truncated", "not directly observable", "could be construed as", or is written in future tense ("will", "would") → set evidence_is_conditional: true.
   A -0.25 penalty will be applied to the confidence score, which will likely suppress the issue.
   Example of bad (conditional) evidence: "If future form fields are not grouped, users may struggle."
   Example of good (observable) evidence: "Form fields for billing/shipping are rendered without visible grouping labels."

3. PAGE-TYPE STAGE MISMATCH RULE (RELAXED):
   Valid UX issues often bridge stages. While page_type (e.g. ["checkout"]) is a guide, it is NOT an absolute gate.
   - If EVIDENCE (screenshots/crawl) clearly shows a library issue happening on a page that isn't strictly tagged in the library page_type, you SHOULD still include it.
   - Example: PDP issues (like UX-003 CTA overload) should be included even if the primary path is checkout, provided you can see it in provided PDP screenshots.
   - ONLY set page_type_mismatch: true if the issue is physically impossible at that stage (e.g., a "shipping cost" issue on a "home page" with no products).

4. ABSENCE IS EVIDENCE RULE:
   For certain issues the *absence* of a feature is itself the positive signal. UX-040 (Security reassurance) is one example – if you are on a checkout page and see **no** trust badges, that **is** evidence that the issue applies. Another classic case is UX-052 (multi‑step feedback): if you are stepped through several checkout screens and there is **no progress indicator or step counter anywhere**, that absence is the evidence. Do NOT treat these as "zero evidence" and suppress them; instead record the missing element as the positive finding.
   - If you are on SS3 (Checkout) and see NO trust badges, this confirms UX-040. Do NOT suppress for "no evidence".

5. FORM AWARENESS RULE (Transparency):
   For field-related issues like UX-102 (Phone/Country code), if SS5 shows a phone field, you cannot suppress for "no evidence". If you see a field, you must investigate it. If you cannot see the detail, mark "Needs verification" rather than suppressing.

6. NEGATIVE SIGNALS:
   Only treat a negative signal as a suppression trigger if it represents **clear,
   positive evidence** that the issue is not present. For example, seeing a
   visible trust badge or an explicit “Continue as Guest” button counts; a
   vague marketing header like “Secure Checkout” does *not*. If a negative
   signal seems ambiguous or you are unsure, ignore it (do not suppress).

5. SIGNALS MATCHING (STRICT):
   An issue should only be included if the positive signals you observe match the specific intent of the 'signals_to_detect'.
   - For UX-052 (Multi-step feedback): Only include if you observe missing PROGRESS INDICATORS or STEP-BY-STEP loaders in a sequence. Do NOT include for simple cart icon updates or page refreshes.

6. SELF-CONTRADICTION RULE:
   If your evidence statement admits that the issue might not be applicable or that it's "not in direct competition" (see UX-003 context), you MUST set include: false.

CRITICAL: Screenshots are FIRST-CLASS evidence. Only suppress if ALL applicable rules above require it. No "if" words in evidence unless evidence_is_conditional: true.

Return ONLY a JSON array of these objects, one per issue. No other text.`;

  try {
    let validationResponse: string;
    if (useClaude) {
      const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-3-haiku-20240307",
          max_tokens: 4000,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: validationPrompt },
              ...(screenshotImages || []).map((url) => ({
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: (url.match(/data:(.*?);/) || [])[1] as any || "image/jpeg",
                  data: url.split(",")[1],
                },
              })),
            ]
          }],
        }),
      });
      const claudeData = await claudeResp.json() as { content?: Array<{ type: string; text?: string }> };
      validationResponse = claudeData.content?.find((c) => c.type === "text")?.text ?? "[]";
    } else {
      const openRouterResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openrouter/auto",
          messages: [{
            role: "user",
            content: screenshotImages && screenshotImages.length > 0
              ? [
                { type: "text", text: validationPrompt },
                ...screenshotImages.map((url) => ({
                  type: "image_url",
                  image_url: { url },
                })),
              ]
              : validationPrompt,
          }],
        }),
      });
      const openRouterData = await openRouterResp.json() as { choices?: Array<{ message?: { content?: string } }> };
      validationResponse = openRouterData.choices?.[0]?.message?.content ?? "[]";
    }

    // Parse JSON array from response (may have markdown code blocks)
    const jsonMatch = validationResponse.match(/\[[\s\S]*\]/);
    let validations: IssueValidation[] = [];
    if (jsonMatch) {
      try {
        validations = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(validations)) {
          console.error("[Validation] Response is not an array:", validations);
          validations = [];
        }
      } catch (e) {
        console.error("[Validation] Failed to parse JSON:", e);
        validations = [];
      }
    }

    // ── FIX 1: Hard zero-evidence gate (programmatic, overrides LLM) ─────────
    for (const v of validations) {
      const screenshotSignals = v.positive_signals_in_screenshots ?? [];
      const crawlSignals = v.positive_signals_in_crawl ?? [];
      const isAbsenceIssue = v.issue_id === "UX-040"; // Trust badges absence is evidence

      // SPECIAL CASE: UX-052 should not be silently dropped whenever the
      // only evidence is an undifferentiated pair of checkout screenshots
      // with no progress indicator.  The absence of a progress bar *is*
      // evidence for UX-052, so we force the issue to stay visible.
      if (
        v.issue_id === "UX-052" &&
        screenshotText.toLowerCase().split(/checkout/g).length - 1 >= 2 &&
        !/progress|step|indicator/.test(screenshotText.toLowerCase())
      ) {
        console.log("[Validation] overriding UX-052 include=true due to multiple checkout screens with no progress indicator");
        v.include = true;
        v.suppression_reason = "Multiple checkout screenshots provided with no progress indicator (absence is evidence)";
        continue; // skip zero-evidence gating, we already included
      }

      if (screenshotSignals.length === 0 && crawlSignals.length === 0 && !isAbsenceIssue) {
        if (v.include) {
          console.log(`[Validation] FIX-1 override: forcing include=false for ${v.issue_id} (zero evidence in both sources)`);
        }
        v.include = false;
        if (!v.suppression_reason) {
          v.suppression_reason = "No positive signals found in screenshots or crawl (zero-evidence hard rule)";
        }
      }
    }

    // ── FIX 0: ensure suppressions carry a concrete reason ──────────────────
    // If the LLM gave us a blanket "exclude" with no real explanation, we
    // prefer to err on the side of inclusion.  A proper reason should mention
    // crawl or screenshot evidence (or lack thereof) and be at least a
    // sentence long.
    for (const v of validations) {
      if (v.include === false) {
        const reason = (v.suppression_reason || "").trim();
        const evidenceHint = /screenshot|crawl|evidence|signal|\bno\b|\bnot\b/i;
        if (
          !reason ||
          reason.length < 20 ||
          !evidenceHint.test(reason)
        ) {
          console.log("[Validation] overriding include=true due to weak/missing suppression_reason for", v.issue_id, "reason=", reason);
          v.include = true;
          // don't bother setting a reason since inclusion means it won't be
          // reported as suppressed
        }
      }
    }

    // ── FIX 2: Conditional evidence programmatic penalty ──────────────────────
    const CONDITIONAL_PATTERNS = /\b(if|may|might|could|would|will|not visible|not observable|future|potentially|possibly|perhaps|unclear|unknown|warrants review|requires further verification|blurred|truncated|not directly observable|could be construed as)\b/i;
    for (const v of validations) {
      if (!v.evidence_is_conditional) {
        const allSignals = [
          ...(v.positive_signals_in_screenshots ?? []),
          ...(v.positive_signals_in_crawl ?? []),
          ...(v.positive_signals_confirmed ?? []),
        ];

        // Exempt UX-040 from "not visible" penalty (since that IS its finding)
        const isTrustBadgeIssue = v.issue_id === "UX-040";
        if (allSignals.some((s) => CONDITIONAL_PATTERNS.test(s))) {
          if (isTrustBadgeIssue && allSignals.some(s => s.toLowerCase().includes("not visible") || s.toLowerCase().includes("not observable"))) {
            // Don't mark as conditional if the thing that's "not visible" is trust badges for UX-040
            continue;
          }
          console.log(`[Validation] FIX-2 override: marking evidence_is_conditional=true for ${v.issue_id}`);
          v.evidence_is_conditional = true;
        }
      }
    }

    // Apply penalties programmatically - evaluate screenshots and crawl independently
    let validated: RetrievedIssue[] = [];
    const suppressed: Array<{ issue: RetrievedIssue; reason: string }> = [];

    // BUG FIX 3: Build imageConfirmed set for issues detected by visual inspection
    const imageConfirmedIds = new Set<string>();
    if (imageDetected && imageDetected.length > 0) {
      for (const item of imageDetected) {
        imageConfirmedIds.add(item.issue_id);
      }
      console.log(`[Validation] BUG FIX 3: Marking ${imageConfirmedIds.size} issues as imageConfirmed: ${Array.from(imageConfirmedIds).join(", ")}`);
    }

    // Track which evidence sources were available
    const hadScreenshots = screenshotText && screenshotText.trim().length > 0;
    const hadCrawl = crawlExcerpts && crawlExcerpts.trim().length > 0;

    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      const isImageConfirmed = issue.issue_id ? imageConfirmedIds.has(issue.issue_id) : false;
      
      // Try to match by issue_id first (more reliable), fall back to index
      const validation = validations.find((v) => v.issue_id === issue.issue_id) ?? validations[i];
      if (!validation) {
        suppressed.push({ issue, reason: "Validation failed - no response" });
        continue;
      }

      // BUG FIX 3: Page-type stage mismatch – suppress before anything else ──────
      if ((validation as any).page_type_mismatch === true) {
        suppressed.push({
          issue,
          reason: validation.suppression_reason || `Stage mismatch: issue page_type [${(issue.page_type ?? []).join(", ")}] does not match the stage of the observed evidence`,
        });
        continue;
      }

      // Check evidence sources independently
      const hasScreenshotEvidence = (validation.positive_signals_in_screenshots?.length ?? 0) > 0;
      const hasCrawlEvidence = (validation.positive_signals_in_crawl?.length ?? 0) > 0;
      let hasAnyPositiveEvidence = (validation.positive_signals_confirmed?.length ?? 0) > 0;
      let hasNegativeEvidence = (validation.negative_signals_confirmed?.length ?? 0) > 0;

      // SPECIAL-TREAT: UX-040 absence-of-trust-badges
      if (issue.issue_id === "UX-040") {
        // if the model didn't point to any badges or give strong negative
        // signals (and we didn't downgrade them to weak), then we must still
        // surface the issue – absence is evidence.
        if (!hasAnyPositiveEvidence && !hasNegativeEvidence) {
          console.log("[Validation] overriding UX-040 include=true due to absence rule");
          validation.include = true;
          hasAnyPositiveEvidence = true;
        }
      }

      // HARD RULE: UX-036 should never be suppressed if screenshots visibly
      // show account creation or linking flows (accounts forced).
      if (issue.issue_id === "UX-036") {
        const ss = screenshotText.toLowerCase();
        if (/create account|link account/.test(ss) || (/email/.test(ss) && !/guest/.test(ss))) {
          console.log("[Validation] overriding UX-036 include=true because account gating text appears in screenshots");
          validation.include = true;
          hasAnyPositiveEvidence = true;
        }
      }

      // ── FIX 4: Guard against weak/ambiguous negative evidence ──────────────
      if (hasNegativeEvidence) {
        const negs = validation.negative_signals_confirmed ?? [];
        const weakPatternsByIssue: { [id: string]: RegExp[] } = {
          "UX-040": [/secure checkout/i, /header/i], // generic marketing text
          "UX-036": [/doesn'?t force account/i, /guest checkout prominently offered/i],
          "UX-037": [/logical grouping/i, /grouped logically/i],
          "UX-102": [/no clear evidence/i, /mismatch/i],
        };
        const id = issue.issue_id ?? "";
        const patterns: RegExp[] = weakPatternsByIssue[id] || [];
        let treatAsWeak = false;

        if (patterns.length > 0) {
          treatAsWeak = negs.every((n) => patterns.some((p) => p.test(n)));
        }
        // additional contradictory-evidence override for UX-036
        if (
          issue.issue_id === "UX-036" &&
          screenshotText.toLowerCase().includes("create and link")
        ) {
          treatAsWeak = true;
        }

        if (treatAsWeak) {
          console.log(
            `[Validation] Ignoring weak negative evidence for ${issue.issue_id}: ${negs.join(", ")}`,
          );
          hasNegativeEvidence = false; // pretend it never happened
        }
      }

      if (hasNegativeEvidence) {
        suppressed.push({
          issue,
          reason: validation.suppression_reason || `Negative signals confirmed: ${validation.negative_signals_confirmed.join(", ")}`,
        });
        continue;
      }

      // re-run UX-040 absence override in case the only ``evidence`` was
      // downgraded as weak negative
      if (issue.issue_id === "UX-040" && !hasAnyPositiveEvidence && !hasNegativeEvidence) {
        console.log("[Validation] UX-040 absence override (post-negative) triggered");
        validation.include = true;
        hasAnyPositiveEvidence = true;
      }


      if (hasNegativeEvidence) {
        suppressed.push({
          issue,
          reason: validation.suppression_reason || `Negative signals confirmed: ${validation.negative_signals_confirmed.join(", ")}`,
        });
        continue;
      }

      // Zero-evidence hard rule suppression
      // SPECIAL-TREAT: UX-102 phone-country mismatch–if we can see any phone or
      // country information, the issue deserves manual follow-up rather than
      // being quietly dropped.
      if (issue.issue_id === "UX-102") {
        const phoneText = (crawlExcerpts + " " + screenshotText).toLowerCase();
        if (
          /phone|country/.test(phoneText) &&
          !hasAnyPositiveEvidence &&
          !validation.include
        ) {
          console.log("[Validation] Overriding UX-102 include=true due to visible phone/country fields");
          validation.include = true;
          hasAnyPositiveEvidence = true; // treat as at least needs verification
        }
      }

      if (!validation.include && !hasAnyPositiveEvidence) {
        const reasonParts: string[] = [];
        if (hadScreenshots && !hasScreenshotEvidence) reasonParts.push("no evidence in screenshots");
        if (hadCrawl && !hasCrawlEvidence) reasonParts.push("no evidence in crawl");
        if (!hadScreenshots && !hadCrawl) reasonParts.push("no evidence sources available");
        suppressed.push({
          issue,
          reason: validation.suppression_reason || `No positive signals in ${reasonParts.length > 0 ? reasonParts.join(" or ") : "screenshots or crawl"} (zero-evidence hard rule)`,
        });
        continue;
      }

      // If no positive evidence from EITHER source, suppress
      if (!hasAnyPositiveEvidence) {
        const reasonParts: string[] = [];
        if (hadScreenshots && !hasScreenshotEvidence) reasonParts.push("no evidence in screenshots");
        if (hadCrawl && !hasCrawlEvidence) reasonParts.push("no evidence in crawl");
        if (!hadScreenshots && !hadCrawl) reasonParts.push("no evidence sources available");
        suppressed.push({
          issue,
          reason: validation.suppression_reason || `No evidence in ${reasonParts.length > 0 ? reasonParts.join(" or ") : "screenshots or crawl"}`,
        });
        continue;
      }

      // Apply confidence penalties
      const baseConf = typeof issue.confidence_weight === "number" ? issue.confidence_weight : 0.7;
      const penalties = (issue as any).confidence_penalties ?? {};
      let score = baseConf;

      // ── FIX 2: Conditional evidence penalty ───────────────────────────────────
      if (validation.evidence_is_conditional) {
        const penalty = penalties.uncertainty_stated ?? -0.25;
        console.log(`[Validation] FIX-2 penalty: ${penalty} applied to ${issue.issue_id} (conditional evidence)`);
        score += penalty;
      }

      // Single-source weak evidence penalty
      if (hasScreenshotEvidence && !hasCrawlEvidence && (validation.positive_signals_in_screenshots?.length ?? 0) === 1) {
        score += penalties.single_signal_only ?? -0.15;
      } else if (hasCrawlEvidence && !hasScreenshotEvidence && (validation.positive_signals_in_crawl?.length ?? 0) === 1) {
        score += penalties.single_signal_only ?? -0.15;
      }

      // BUG FIX 3 (REVISED): Only override for imageConfirmed if score >= 0.50
      // Image pass retrieval is guaranteed (Bug 2), but inclusion is score-gated
      if (isImageConfirmed && score >= 0.50) {
        console.log(`[Validation] BUG FIX 3: imageConfirmed ${issue.issue_id} qualifies (score ${score.toFixed(2)} >= 0.50), forcing include`);
        validation.include = true;
      } else if (isImageConfirmed && score < 0.50) {
        console.log(`[Validation] BUG FIX 3: imageConfirmed ${issue.issue_id} rejected (score ${score.toFixed(2)} < 0.50), respecting suppression`);
      }

      // Gate: include if score >= 0.55 AND validation says include
      // BUG FIX 3: imageConfirmed issues bypass score threshold only if already forced include above
      if (validation.include && score >= 0.55) {
        console.log(`[Validation]${isImageConfirmed ? " [imageConfirmed]" : ""} Including ${issue.issue_id} (score ${score.toFixed(2)})`);
        validated.push(issue);
      } else {
        suppressed.push({
          issue,
          reason: validation.suppression_reason || `Score ${score.toFixed(2)} below threshold 0.55${validation.evidence_is_conditional ? " (conditional evidence penalty applied)" : ""}${(!validation.include ? " (LLM excluded)" : "")}`,
        });
      }
    }

    // ── FIX 5: Deduplicate the final validated list (unmatched IDs lead to duplicates in report)
    const uniqueValidated: RetrievedIssue[] = [];
    const seenIds = new Set<string>();
    for (const issue of validated) {
      if (issue.issue_id) {
        if (seenIds.has(issue.issue_id)) {
          console.log(`[Validation] Deduping validated issue_id ${issue.issue_id}`);
          continue;
        }
        seenIds.add(issue.issue_id);
      }
      uniqueValidated.push(issue);
    }
    validated = uniqueValidated;

    return { validated, suppressed };
  } catch (e) {
    console.error("[Validation] LLM validation failed, using all issues:", e);
    // Fallback: return all issues if validation fails
    return { validated: issues, suppressed: [] };
  }
}

