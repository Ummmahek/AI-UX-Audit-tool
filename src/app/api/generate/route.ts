import { NextResponse } from "next/server";

import {
  buildCompanyGroundedMessages,
  buildGenericMessages,
  formatMessagesForResponses,
  imageDetectionPass,
  loadIssueLibrary,
  simpleRetrieveIssues,
  retrieveRelevantIssues,
  inferSiteType,
  filterApplicableIssues,
  validateIssuesWithLLM,
  type ImageDetectedResult,
  type Issue,
  type RetrievedIssue,
} from "@/lib/ux";
import { crawlKeyPaths, type CrawlResult } from "@/lib/crawl";
import { runDeterministicDetection } from '@/lib/detect';
import { detectSiteTypeWithFallback } from '@/lib/siteTypeDetection';
import { deterministicSignalCheck } from '@/lib/signalMatch';
import { crawlWebsite, shouldUsePlaywright } from '@/lib/crawlPlaywright';

export const runtime = "nodejs";

type MultipartPayload = {
  url: string;
  goal: string;
  useCompany: boolean;
  topK: number;
  model: string;
  screenshots: File[];
};

async function parseRequest(request: Request): Promise<{
  url?: string;
  goal?: string;
  useCompany?: boolean;
  topK?: number;
  model?: string;
  screenshots: File[];
}> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const fd = await request.formData();
    const url = String(fd.get("url") ?? "");
    const goal = String(fd.get("goal") ?? "");
    const model = String(fd.get("model") ?? "openrouter/auto");
    const useCompany = String(fd.get("useCompany") ?? "true") === "true";
    const topKRaw = Number(fd.get("topK") ?? 7);
    const topK = Number.isFinite(topKRaw) ? topKRaw : 7;
    const screenshots = fd
      .getAll("screenshots")
      .filter((v): v is File => v instanceof File);

    return { url, goal, useCompany, topK, model, screenshots };
  }

  const body = await request.json();
  const {
    url,
    goal,
    useCompany = true,
    topK = 7,
    model = "openrouter/auto",
  } = body ?? {};
  return { url, goal, useCompany, topK, model, screenshots: [] };
}

async function fileToDataUrl(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const mime = file.type || "application/octet-stream";
  return `data:${mime};base64,${base64}`;
}

// Temporary helper: build a plain-text representation of screenshots for
// retrieval purposes. Tesseract OCR has been removed — structural detection
// is now handled by Playwright DOM checks and visual evidence comes through
// the imageDetectionPass. Returning empty string to avoid polluting
// deterministic keyword matching.
async function extractTextFromScreenshots(files: File[]): Promise<string> {
  return '';
}

const SAMPLE_REPORT = `Journey summary (sample)
- Discover: Homepage uses large hero with competing CTAs. Needs verification: language/location selector hidden in header; pop-ups appear before intent.
- Decide: Product cards vary in layout, slowing scan. Price/fees are revealed late which likely triggers drop-off.
- Book: Checkout flow hints at late account creation + coupon chase; may lack progress clarity.

Confirmed patterns to address now
- CTA overload dilutes the primary action on landing.
- Language/region controls are not persistent, forcing re-selection.
- Pricing transparency is deferred until after seat selection/payment.

Needs verification on the live site
- Presence of modal/pop-up on first load.
- Inconsistent product card hierarchy on PLP.
- Trust cues and upfront fees on checkout.

Where a manual UX audit should focus next
- Validate the first 2 screens for intrusive pop-ups and CTA hierarchy.
- Capture PLP/seat-selection for consistency and fee transparency.
- Observe checkout for account gating, coupon chase, and progress clarity.`;

export async function POST(request: Request) {
  let url: string | undefined;
  let goal: string | undefined;
  let useCompany = true;
  let topK = 7;
  let model = "openrouter/auto";
  // user-uploaded screenshots
  let screenshots: File[] = [];
  // aggregated screenshot URLs from user + crawler
  let allScreenshotUrls: string[] = [];
  let hasScreenshots = false;
  let crawlContext = "";
  let deterministicIssues: any[] = [];
  let screenshotText = "";
  try {
    const parsed = (await parseRequest(request)) as MultipartPayload;
    url = parsed.url;
    goal = parsed.goal;
    useCompany = parsed.useCompany ?? true;
    topK = parsed.topK ?? 40;
    model = parsed.model ?? "openrouter/auto";
    screenshots = parsed.screenshots ?? [];
    hasScreenshots = Array.isArray(screenshots) && screenshots.length > 0;

    if (!url || !goal) {
      return NextResponse.json(
        { error: "URL and goal are required." },
        { status: 400 },
      );
    }

    // Crawl key paths to provide evidence-rich context (secure + best-effort).
    let crawlResult: CrawlResult = { pages: [], targetUrl: '', blockedOrLimited: false };
    let crawlStatus: { blocked?: boolean; failed?: boolean; bodyLength?: number } = {};
    try {
      crawlResult = await crawlKeyPaths(url);

      // Escalate to Playwright if the crawl returned JS-rendered thin content
      const combinedBodyText = crawlResult.pages.map((p) => p.excerpt ?? '').join(' ');
      const shouldUse = shouldUsePlaywright(combinedBodyText);
      console.log('[PLAYWRIGHT] shouldUsePlaywright result:', shouldUse);
      console.log('[PLAYWRIGHT] combinedBodyText length:', combinedBodyText.length);
      console.log('[PLAYWRIGHT] combinedBodyText sample:', combinedBodyText.slice(0, 200));
      if (shouldUse) {
        try {
          const pwResult = await crawlWebsite(url);
          crawlStatus = {
            blocked: pwResult.blocked,
            failed: false,
            bodyLength: pwResult.bodyText ? pwResult.bodyText.length : 0,
          };
          if (!pwResult.blocked && pwResult.bodyText) {
            // convert to CrawlResult shape so outer logic stays the same
            crawlResult.pages = [
              {
                url,
                requestedUrl: url,
                finalUrl: url,
                excerpt: pwResult.bodyText,
                screenshot: pwResult.screenshots[0] ? `data:image/png;base64,${pwResult.screenshots[0].toString('base64')}` : undefined,
                label: 'homepage',
              } as any,
            ];
          }
        } catch (err) {
          console.error('[PLAYWRIGHT] crawlWebsite failed:', err);
          crawlStatus = {
            blocked: false,
            failed: true,
            bodyLength: 0,
          };
          // Playwright failed — continue with cheerio result
        }
      } else {
        // Cheerio crawl - assume not blocked if we got content
        crawlStatus = {
          blocked: false,
          failed: false,
          bodyLength: combinedBodyText.length,
        };
      }

      // collect any screenshots produced by the crawler
      const crawlerScreens = crawlResult.pages
        .map((p) => (p as any).screenshot)
        .filter((s): s is string => typeof s === 'string');
      if (crawlerScreens.length > 0) {
        allScreenshotUrls.push(...crawlerScreens);
        console.log('[PLAYWRIGHT] captured screenshots from', crawlerScreens.length, 'pages');
      }

      // Run deterministic detection based on DOM flags
      deterministicIssues = runDeterministicDetection(
        crawlResult.pages.map((p) => ({
          url: p.finalUrl ?? p.requestedUrl,
          label: p.label ?? 'unknown',
          domChecks: p.domChecks ?? ({} as any),
        })),
        screenshotText
      );

      const pageBlocks = crawlResult.pages
        .map((p) => {
          const header = `### ${p.label.toUpperCase()}`;
          const meta = [
            `requested: ${p.requestedUrl}`,
            p.finalUrl ? `final: ${p.finalUrl}` : null,
            typeof p.status === "number" ? `status: ${p.status}` : null,
            p.blockedByBotProtection ? `bot_protection: true` : null,
            p.error ? `error: ${p.error}` : null,
            p.screenshot ? `screenshot: available` : null,
          ]
            .filter(Boolean)
            .join(" | ");
          const body = p.excerpt ? `\n${p.excerpt}` : "";
          return `${header}\n${meta}${body}`;
        })
        .join("\n\n");

      crawlContext = `\n\n---\nSITE CRAWL EXCERPTS (best-effort; may be partial/blocked)\nNote: ${crawlResult.note ?? "Use as supporting evidence only."
        }\n\n${pageBlocks}\n---\n`;
    } catch (e) {
      // Smooth fallback: continue without crawl.
      crawlContext = `\n\n---\nSITE CRAWL EXCERPTS\nCrawl skipped: ${e instanceof Error ? e.message : "unknown error"
        }\n---\n`;
    }

    const claudeKey = process.env.CLAUDE_API_KEY;
    const openRouterKey = process.env.OPENROUTER_API_KEY;

    // Evidence-aware retrieval: run after crawl so retrieval can use crawl excerpts
    let retrieved: RetrievedIssue[] = [];
    let suppressedIssues: Array<{ issue: RetrievedIssue; reason: string }> = [];
    let imageDetectedResults: ImageDetectedResult[] = [];
    let metadata: any = {}; // added for site type/terminology info
    let siteTypeDetection: { type: string; confidence: 'high' | 'medium' | 'low'; evidence: string[] } = {
      type: 'corporate',
      confidence: 'low',
      evidence: [],
    };

    if (useCompany) {
      try {
        const issueLibrary = await loadIssueLibrary();
        // derive any text from user-uploaded screenshots for negative-signal checking (reuse later for validation)
        screenshotText = await extractTextFromScreenshots(screenshots);
        console.log('[OCR DEBUG] Screenshot text length:', screenshotText.length);
        console.log('[OCR DEBUG] First 300 chars:', screenshotText.slice(0, 300));

        // convert user files to data URLs and merge crawler screenshots
        const userScreenshotUrls = await Promise.all(screenshots.map(fileToDataUrl));
        allScreenshotUrls.push(...userScreenshotUrls);
        hasScreenshots = allScreenshotUrls.length > 0;

        // detect site type EARLY using clean crawl text, not wrapper context
        const siteTypeText = crawlResult.pages
          .map((p) => p.excerpt ?? '')
          .filter(Boolean)
          .join('\n\n');
        const normalizedUrl = url; // assuming url is already normalized, or we can normalize it
        siteTypeDetection = await detectSiteTypeWithFallback(
          siteTypeText,
          normalizedUrl,
          undefined,
          undefined,
          {
            // pass any meta/enrichment available here
          },
          crawlStatus
        );
        console.log(`[API] Site Type: ${siteTypeDetection.type} (${siteTypeDetection.confidence})`);

        // filter applicable issues before any vision pass
        const applicableIssues = filterApplicableIssues(issueLibrary, siteTypeDetection.type);
        console.log(`[API] Filtered: ${applicableIssues.length}/${issueLibrary.length} issues applicable`);

        // Image-led detection pass (before retrieval) when screenshots are present
        if (hasScreenshots && (claudeKey || openRouterKey)) {
          try {
            const apiKey = claudeKey || openRouterKey!;
            const useClaude = Boolean(claudeKey);
            const screenshotUrls = [...allScreenshotUrls];


            // The prompt already instructs the LLM to only flag what it can see
            // visually, so here we simply remove issues that are *purely* DOM‑checkable
            // (and anything the deterministic rules already confirmed this run).
            const PURELY_DOM_CHECKABLE_IDS = new Set<string>([
              // heading/meta rules
              'DET-001','DET-002','DET-003','DET-004','DET-005','DET-006','DET-007','DET-008',
              // checkout DOM rules
              'DET-009','DET-010','DET-011','DET-012','DET-013','DET-014','DET-015','DET-016','DET-017',
              // other library issues guaranteed DOM‑checkable
              'UX-063','UX-102','UX-067','UX-073','UX-028',
            ]);

            const deterministicConfirmedIds = new Set(
              deterministicIssues.map((i) => i.issue_id),
            );

            let visionLibrary = applicableIssues.filter(
              (issue) =>
                !!issue.issue_id &&
                !PURELY_DOM_CHECKABLE_IDS.has(issue.issue_id) &&
                !deterministicConfirmedIds.has(issue.issue_id),
            );

            // --- FIX 1: score and cap to top K relevant issues ---
            function scoreIssueRelevance(issue: typeof issueLibrary[0], goal: string, crawlContext?: string, screenshotText?: string): number {
              const searchText = `${goal ?? ''} ${crawlContext ?? ''} ${screenshotText ?? ''}`.toLowerCase();
              const issueFields = [
                issue.issue_title ?? '',
                (issue as any).detection_hint ?? '',
                Array.isArray(issue.signals_to_detect) ? issue.signals_to_detect.join(' ') : '',
                Array.isArray(issue.page_type) ? issue.page_type.join(' ') : '',
                issue.user_problem ?? '',
              ].join(' ').toLowerCase();

              const searchTokens = new Set(searchText.match(/\b[a-z0-9]{3,}\b/g) ?? []);
              const issueTokens = new Set(issueFields.match(/\b[a-z0-9]{3,}\b/g) ?? []);
              const overlapScore = [...searchTokens].filter((t) => issueTokens.has(t)).length;

              const issuePageTypes = new Set(
                Array.isArray(issue.page_type) ? issue.page_type.map((p) => p.toLowerCase()) : [],
              );
              let stageBoost = 0;
              if (/\b(checkout|payment|order|billing|shipping|purchase|secure)\b/.test(searchText)) {
                if (issuePageTypes.has('checkout') || issuePageTypes.has('payment')) stageBoost += 4;
              }
              if (/\b(cart|bag|basket|add to cart|shopping)\b/.test(searchText)) {
                if (issuePageTypes.has('cart')) stageBoost += 4;
              }
              if (/\b(product|pdp|item|price|sku|add to bag)\b/.test(searchText)) {
                if (issuePageTypes.has('pdp') || issuePageTypes.has('product_detail') || issuePageTypes.has('product')) stageBoost += 4;
              }
              if (/\b(login|register|account|sign in|sign up|auth)\b/.test(searchText)) {
                if (issuePageTypes.has('account') || issuePageTypes.has('authentication')) stageBoost += 4;
              }

              const signalMatchScore = Array.isArray(issue.signals_to_detect)
                ? issue.signals_to_detect.reduce((score, signal) => {
                    const signalLower = signal.toLowerCase();
                    return score + (searchText.includes(signalLower) ? 1 : 0);
                  }, 0)
                : 0;

              const screenshotBonus = screenshotText && screenshotText.trim().length > 0
                ? (issue.issue_title ?? '').toLowerCase().includes('progress') || issuePageTypes.has('checkout') ? 1 : 0
                : 0;

              return overlapScore + stageBoost + signalMatchScore * 0.5 + screenshotBonus;
            }
            const TOP_K_VISION = 20;
            const ranked = visionLibrary
              .map((issue) => ({ issue, score: scoreIssueRelevance(issue, goal ?? '', crawlContext, screenshotText) }))
              .sort((a, b) => b.score - a.score)
              .slice(0, TOP_K_VISION)
              .map(({ issue }) => issue);
            visionLibrary = ranked;

            console.log('[IMAGE PASS] Vision-only issue count after filtering:', visionLibrary.length);
            console.log('[IMAGE PASS] Vision-only issue IDs:', visionLibrary.map((i) => i.issue_id));
            console.log('[IMAGE PASS] Vision library capped to top', visionLibrary.length, 'issues');
            console.log('[IMAGE PASS] Top vision issues:', visionLibrary.map((i) => i.issue_id));

            const rawImageIssues = await imageDetectionPass(
              screenshotUrls,
              visionLibrary,
              apiKey,
              useClaude,
              goal, // pass audit goal for context
            );

            // --- FIX 3: dedupe image results by ID, keeping highest confidence ---
            const seenIds = new Map<string, typeof rawImageIssues[0]>();
            for (const issue of rawImageIssues) {
              const existing = seenIds.get(issue.issue_id);
              if (!existing || (issue.confidence ?? 0) > (existing.confidence ?? 0)) {
                seenIds.set(issue.issue_id, issue);
              }
            }
            const dedupedImageIssues = Array.from(seenIds.values());
            console.log('[API] Vision pass final deduped issues:', dedupedImageIssues.map((i) => i.issue_id));

            imageDetectedResults = dedupedImageIssues;

          } catch (e) {
            console.error(`[API] imageDetectionPass failed (continuing without):`, e);
          }
        }

        // use the already-detected site type from crawl content instead of re-detecting later
        const siteType = siteTypeDetection.type;
        console.log(`[API] inferred site type: ${siteType}`);

        // use enhanced retrieval helper which also returns site type & terminology
        const retrievalResult = await retrieveRelevantIssues(
          url,
          goal,
          topK,
          crawlContext,
          screenshotText,
          hasScreenshots,
          imageDetectedResults.length > 0 ? imageDetectedResults : undefined,
          siteType,
        );
        retrieved = retrievalResult.issues;
        // pass metadata to be included in the response (frontend can show badge)
        metadata = {
          siteType: retrievalResult.siteType,
          terminology: retrievalResult.terminology,
          applicableIssues: retrievalResult.applicableCount,
          totalIssues: retrievalResult.totalCount,
          confidence: siteTypeDetection.confidence,
          evidence: siteTypeDetection.evidence,
          issuesRetrieved: retrieved.length,
          accessBlocked: crawlResult.blockedOrLimited,
        };
        // ensure existing retrieved issues carry imageConfirmed flag
        const imageConfirmedIds = new Set(imageDetectedResults.map((r) => r.issue_id));
        retrieved = retrieved.map((iss) => ({
          ...iss,
          imageConfirmed: imageConfirmedIds.has(iss.issue_id ?? ''),
        }));
        console.log(`[API] Retrieved ${retrieved.length} issues for url: ${url}, goal: ${goal}`);
        
        // BUG FIX 2: Append image-detected issues not already in retrieved (bypass topK cap)
        if (imageDetectedResults.length > 0) {
          const retrievedIds = new Set(retrieved.map((iss) => iss.issue_id).filter(Boolean));
          const missingImageDetected = imageDetectedResults.filter((r) => !retrievedIds.has(r.issue_id));
          
          if (missingImageDetected.length > 0) {
            // Add missing image-detected issues to the end of the retrieved list
            const byId = new Map<string, Issue>();
            for (const issue of issueLibrary) {
              if (issue.issue_id) byId.set(issue.issue_id, issue);
            }
            for (const item of missingImageDetected) {
              const issue = byId.get(item.issue_id);
              if (issue) {
                (issue as any).source = "image-detection"; // Mark for BUG FIX 3
                (issue as any).imageConfirmed = true;
                retrieved.push(issue);
              }
            }
            console.log(`[API] Appended ${missingImageDetected.length} image-detected issues (outside topK): ${missingImageDetected.map((r) => r.issue_id).join(", ")}`);
          }
          
          const forceIncluded = imageDetectedResults.map((r) => r.issue_id);
          console.log(`[API] Force-included from image pass (all): ${forceIncluded.join(", ") || "(none)"}`);
        }
      } catch (e) {
        // fallback: leave retrieved empty and continue
        console.error(`[API] Issue retrieval failed:`, e);
        retrieved = [];
      }
    }

    if (!claudeKey && !openRouterKey) {
      return NextResponse.json({
        report: SAMPLE_REPORT,
        retrievedIssues: retrieved,
        deterministicIssues,
        metadata,
        usedMock: true,
        model,
        usedCompany: useCompany,
        note: "Set CLAUDE_API_KEY or OPENROUTER_API_KEY to generate live reports.",
      });
    }

    // Deterministic signal matching — replaces validateIssuesWithLLM()
    let validatedIssues = retrieved;
    let totalEstimatedFixHours = 0;
    if (useCompany && retrieved.length > 0) {
      const crawlTextCombined = crawlResult.pages.map((p) => p.excerpt ?? '').join(' ');

      const validated: typeof retrieved = [];
      const suppressed: Array<{ issue: typeof retrieved[0]; reason: string }> = [];

      const allCandidateIssues = retrieved;
      console.log('[DEBUG] imageConfirmed flags:', 
        allCandidateIssues.map(i => ({ id: i.issue_id, confirmed: (i as any).imageConfirmed }))
      );

      for (const issue of allCandidateIssues) {
        // Deterministic issues (from detect.ts) are NEVER suppressed
        if ((issue as any).source === 'deterministic') {
          validated.push(issue);
          continue;
        }
        // Image-confirmed issues are protected from suppression (preserve existing behaviour)
        if ((issue as any).imageConfirmed === true) {
          validated.push(issue);
          continue;
        }
        // All other issues go through deterministic signal matching
        const result = deterministicSignalCheck(issue, crawlTextCombined, screenshotText);
        if (!result.suppressed) {
          validated.push({ ...issue, confidence: result.score });
        } else {
          suppressed.push({ issue, reason: result.suppression_reason ?? 'No signals matched' });
        }
      }

      // Merge deterministic issues — add any that aren't already in the validated list
      for (const det of deterministicIssues) {
        const alreadyPresent = validated.some((v) => v.issue_id === det.issue_id);
        if (!alreadyPresent) {
          validated.push({
            issue_id: det.issue_id,
            issue_title: det.issue_title,
            source: 'deterministic',
            confidence: det.confidence,
            evidence: det.evidence,
            // Fill other required Issue fields with safe defaults if needed
          } as any);
        }
      }

      validatedIssues = validated;
      // deduplicate suppressed list by issue_id to avoid noise
      const deduplicatedSuppressed = suppressed.filter(
        (item, index, self) =>
          index === self.findIndex((s) => s.issue.issue_id === item.issue.issue_id)
      );
      suppressedIssues = deduplicatedSuppressed;

      // Conflict resolution: keep the stronger visually confirmed/validated issue
      // for near-duplicate UX problems that share the same core title.
      const normalizeIssueTitle = (title: string | undefined) =>
        (title ?? '')
          .toLowerCase()
          .replace(/\b(no|missing|without|misleading|inaccurate|unclear|hidden|hidden steps?)\b/g, '')
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      const consolidated: RetrievedIssue[] = [];
      const seenKeys = new Map<string, RetrievedIssue>();
      for (const issue of validatedIssues) {
        const key = normalizeIssueTitle(issue.issue_title);
        const existing = seenKeys.get(key);
        if (!existing) {
          seenKeys.set(key, issue);
          consolidated.push(issue);
          continue;
        }

        const score = (item: RetrievedIssue) =>
          ((item as any).imageConfirmed ? 100 : 0) +
          (typeof item.confidence === 'number' ? item.confidence : 0.5);

        if (score(issue) > score(existing)) {
          seenKeys.set(key, issue);
          const replaceIndex = consolidated.findIndex((i) => i.issue_id === existing.issue_id);
          if (replaceIndex !== -1) consolidated[replaceIndex] = issue;
        }
      }

      const finalIssues = consolidated.map((issue) => ({
        ...issue,
        effort_level: (issue as any).effort?.level ?? null,
        estimated_fix_hours: (issue as any).effort?.estimated_hours ?? 0,
      }));
      totalEstimatedFixHours = finalIssues.reduce(
        (sum, issue) => sum + (issue.estimated_fix_hours ?? 0),
        0,
      );
      validatedIssues = finalIssues;
    }

    const messages = useCompany
      ? buildCompanyGroundedMessages(url, goal, validatedIssues, suppressedIssues, {
          siteType: siteTypeDetection.type,
          applicableCount: retrieved.length,
          screenshotCount: allScreenshotUrls.length,
        })
      : buildGenericMessages(url, goal);

    const prompt = `${formatMessagesForResponses(messages)}${crawlContext}`;

    const apiKey = process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
      return NextResponse.json({
        report: SAMPLE_REPORT,
        retrievedIssues: retrieved,
        deterministicIssues,
        metadata,
        usedMock: true,
        model,
        usedCompany: useCompany,
        note: "Set OPENROUTER_API_KEY to generate live reports.",
      });
    }

    let report = "";
    let usedModelName = model;

    function dedupeReportText(text: string): string {
      // Split the report into loose "paragraphs" (blocks separated by two or
      // more newlines).  Each block should correspond roughly to a single
      // finding or section the model has produced.
      const parts = text.split(/\n{2,}/g);
      const bestById: Record<
        string,
        { part: string; score: number; index: number }
      > = {};
      const evidenceTerms = [
        "screenshot",
        "crawl",
        "evidence",
        "visible",
        "shown",
        "observed",
      ];

      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const ids = p.match(/UX-\d{3}/g);
        if (!ids) continue;
        for (const id of ids) {
          // simple heuristic: score higher if paragraph contains more evidence
          // keywords and is longer (more words)
          let score = p.split(/\s+/).length * 0.01;
          const lower = p.toLowerCase();
          for (const term of evidenceTerms) {
            score += (lower.split(term).length - 1) * 0.5;
          }

          if (!bestById[id] || score > bestById[id].score) {
            bestById[id] = { part: p, score, index: i };
          }
        }
      }

      // Reconstruct report, keeping the best paragraph for each ID and
      // preserving original order of the chosen parts.
      const chosen = new Set<string>();
      const finalParts: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const ids = p.match(/UX-\d{3}/g);
        if (!ids) {
          finalParts.push(p);
          continue;
        }
        // keep part only if it's the best one for the *first* ID we see
        const id = ids[0];
        if (chosen.has(id)) continue;
        if (bestById[id] && bestById[id].index === i) {
          finalParts.push(p);
          chosen.add(id);
        }
      }

      return finalParts.join("\n\n");
    }

    // Try Claude first if a CLAUDE_API_KEY is present, but fall back to OpenRouter on error
    if (claudeKey) {
      // clear log: duplicate issues will also be pruned from the text afterwards
      try {
        // Try multiple model names in order (based on your rate limits: Claude Sonnet Active, Claude Haiku Active, etc.)
        const modelNames = [
          "claude-3-5-haiku-20241022",
          "claude-3-haiku-20240307",
          "claude-3-sonnet-20240229",
          "claude-3-opus-20240229",
        ];

        let lastError: Error | null = null;
        for (const modelName of modelNames) {
          try {
            console.log(`[API] Trying Claude model: ${modelName}`);
            const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "x-api-key": claudeKey,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model: modelName,
                max_tokens: 4000,
                messages: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "text",
                        text: hasScreenshots
                          ? `${prompt}\n\nNote: Screenshots were uploaded for this audit. Use them as the primary source of visual evidence where relevant, but the raw image data is not included here.`
                          : prompt,
                      },
                    ],
                  },
                ],
              }),
            });

            const claudeData = await claudeResponse.json() as {
              content?: Array<{ type: string; text?: string }>;
              error?: { message?: string; type?: string };
              [key: string]: unknown;
            };

            if (!claudeResponse.ok) {
              console.log(`[API] Model ${modelName} failed:`, claudeData.error?.message);
              lastError = new Error(claudeData.error?.message || `Model ${modelName} not available`);
              continue; // Try next model
            }

            const textPart = claudeData.content?.find((c) => c.type === "text");
            report = textPart?.text ?? "No text returned from Claude.";
            usedModelName = modelName;
            console.log(`[API] Successfully used Claude model: ${modelName}`);
            break; // Success, exit loop
          } catch (e) {
            lastError = e instanceof Error ? e : new Error(String(e));
            continue; // Try next model
          }
        }

        if (!report) {
          throw lastError || new Error("All Claude models failed");
        }
      } catch (e) {
        console.error("[API] Claude call failed, falling back to OpenRouter:", e);
      }
    }

    // If Claude was not used or failed, use OpenRouter as before
    if (!report) {
      const apiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openRouterKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openrouter/auto",
          max_tokens: 2000,
          messages: [
            {
              role: "user",
              content: hasScreenshots
                ? [
                  {
                    type: "text",
                    text: `${prompt}\n\nAttached screenshots:\n- Treat screenshots as the strongest source of UX evidence (stronger than crawl excerpts or inferred absence).\n- If screenshots clearly show PDPs, carts, or checkout flows, treat those stages as observable and DO NOT describe them as missing solely because the crawl did not hit them.\n- If a claim cannot be supported by the screenshots or crawl excerpts, label it "Needs verification" or "Not observable via crawl – Requires manual verification".\n`,
                  },
                  ...(await Promise.all(
                    screenshots.slice(0, 6).map(async (file) => ({
                      type: "image_url",
                      image_url: { url: await fileToDataUrl(file) },
                    })),
                  )),
                ]
                : prompt,
            },
          ],
        }),
      });

      const responseData = await apiResponse.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };

      if (!apiResponse.ok || responseData.error) {
        throw new Error(responseData.error?.message || "OpenRouter API error");
      }

      report =
        responseData.choices?.[0]?.message?.content || "No text returned from the model.";
      usedModelName = "openrouter/auto";
    }

    // enforce deduplication on the generated report text itself
    report = dedupeReportText(report);

    // Verification: log whether image-detected IDs appeared in the final report
    if (imageDetectedResults.length > 0) {
      const inReport = imageDetectedResults.filter((r) => report.includes(r.issue_id)).map((r) => r.issue_id);
      const missing = imageDetectedResults.map((r) => r.issue_id).filter((id) => !report.includes(id));
      console.log(`[API] Image-detected IDs in final report: ${inReport.join(", ") || "(none)"}`);
      if (missing.length > 0) {
        console.log(`[API] Image-detected IDs missing from report: ${missing.join(", ")}`);
      }
    }

    return NextResponse.json({
      report,
      retrievedIssues: retrieved.map((issue) => ({
        ...issue,
        is_validated: validatedIssues.some((v) => v.issue_id === issue.issue_id),
      })),
      finalIssues: validatedIssues,
      total_estimated_fix_hours: totalEstimatedFixHours,
      deterministicIssues,
      suppressedIssues: suppressedIssues.map((s) => ({
        issue_id: s.issue.issue_id,
        issue_title: s.issue.issue_title,
        reason: s.reason,
      })),
      usedMock: false,
      model: usedModelName,
      usedCompany: useCompany,
    });
  } catch (error: unknown) {
    console.error("API error", error);
    const err = error as { status?: number; message?: string };
    const isQuotaOrRateLimit =
      err?.status === 429 ||
      err?.status === 402 ||
      (typeof err?.message === "string" &&
        (err.message.toLowerCase().includes("quota") ||
          err.message.toLowerCase().includes("exceeded") ||
          err.message.toLowerCase().includes("rate") ||
          err.message.toLowerCase().includes("limit") ||
          err.message.toLowerCase().includes("insufficient")));

    // On any quota/rate/billing error, return sample report so demo still works
    if (isQuotaOrRateLimit) {
      let retrieved: RetrievedIssue[] = [];
      try {
        if (url && goal && useCompany) {
          const issueLibrary = await loadIssueLibrary();
          const screenshotText = await extractTextFromScreenshots(screenshots);
          retrieved = simpleRetrieveIssues(
            issueLibrary,
            url,
            goal,
            topK,
            crawlContext,
            screenshotText,
            hasScreenshots,
          );
        }
      } catch {
        // ignore
      }
      return NextResponse.json({
        report: SAMPLE_REPORT,
        retrievedIssues: retrieved,
        deterministicIssues,
        usedMock: true,
        model: "openrouter/auto",
        usedCompany: useCompany,
        note: "API limit reached. Showing sample report so you can still run the demo. Check your OpenRouter account/billing to restore live reports.",
      });
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

