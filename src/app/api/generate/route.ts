import { NextResponse } from "next/server";

import {
  buildCompanyGroundedMessages,
  buildGenericMessages,
  formatMessagesForResponses,
  imageDetectionPass,
  loadIssueLibrary,
  simpleRetrieveIssues,
  validateIssuesWithLLM,
  type ImageDetectedResult,
  type RetrievedIssue,
} from "@/lib/ux";
import { crawlKeyPaths } from "@/lib/crawl";

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
// retrieval purposes. Currently just concatenates file names, but this
// can be replaced later with proper OCR or metadata extraction.
async function extractTextFromScreenshots(files: File[]): Promise<string> {
  if (!files || files.length === 0) return "";
  return files.map((f) => f.name).join(" ");
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
  let screenshots: File[] = [];
  let hasScreenshots = false;
  let crawlContext = "";

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
    try {
      const crawl = await crawlKeyPaths(url);
      const pageBlocks = crawl.pages
        .map((p) => {
          const header = `### ${p.label.toUpperCase()}`;
          const meta = [
            `requested: ${p.requestedUrl}`,
            p.finalUrl ? `final: ${p.finalUrl}` : null,
            typeof p.status === "number" ? `status: ${p.status}` : null,
            p.blockedByBotProtection ? `bot_protection: true` : null,
            p.error ? `error: ${p.error}` : null,
          ]
            .filter(Boolean)
            .join(" | ");
          const body = p.excerpt ? `\n${p.excerpt}` : "";
          return `${header}\n${meta}${body}`;
        })
        .join("\n\n");

      crawlContext = `\n\n---\nSITE CRAWL EXCERPTS (best-effort; may be partial/blocked)\nNote: ${crawl.note ?? "Use as supporting evidence only."
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
    let screenshotText = "";
    let imageDetectedResults: ImageDetectedResult[] = [];

    if (useCompany) {
      try {
        const issueLibrary = await loadIssueLibrary();
        // derive any text from screenshots for negative-signal checking (reuse later for validation)
        screenshotText = await extractTextFromScreenshots(screenshots);

        // Image-led detection pass (before retrieval) when screenshots are present
        if (hasScreenshots && (claudeKey || openRouterKey)) {
          try {
            const apiKey = claudeKey || openRouterKey!;
            const useClaude = Boolean(claudeKey);
            const screenshotUrls = await Promise.all(screenshots.map(fileToDataUrl));
            imageDetectedResults = await imageDetectionPass(screenshotUrls, issueLibrary, apiKey, useClaude);
            console.log(`[API] imageDetectionPass returned ${imageDetectedResults.length} issues: ${imageDetectedResults.map((r) => r.issue_id).join(", ") || "(none)"}`);
          } catch (e) {
            console.error(`[API] imageDetectionPass failed (continuing without):`, e);
          }
        }

        retrieved = simpleRetrieveIssues(
          issueLibrary,
          url,
          goal,
          topK,
          crawlContext,
          screenshotText,
          hasScreenshots,
          imageDetectedResults.length > 0 ? imageDetectedResults : undefined,
        );
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
        usedMock: true,
        model,
        usedCompany: useCompany,
        note: "Set CLAUDE_API_KEY or OPENROUTER_API_KEY to generate live reports.",
      });
    }

    // Validate issues via LLM and apply penalties programmatically
    let validatedIssues = retrieved;
    if (useCompany && retrieved.length > 0) {
      try {
        const apiKey = claudeKey || openRouterKey!;
        const useClaude = Boolean(claudeKey);

        // Fix for screenshot blindness: convert files to data URLs before validation
        const screenshotImages = hasScreenshots
          ? await Promise.all(screenshots.map(fileToDataUrl))
          : undefined;

        const validationResult = await validateIssuesWithLLM(
          retrieved,
          url,
          goal,
          crawlContext,
          screenshotText,
          apiKey,
          useClaude,
          screenshotImages,
          imageDetectedResults.length > 0 ? imageDetectedResults : undefined,
        );
        validatedIssues = validationResult.validated;
        suppressedIssues = validationResult.suppressed;
        console.log(`[API] Validated: ${validatedIssues.length} included, ${suppressedIssues.length} suppressed`);

        // extra dedup step at the API layer just in case
        const seen = new Set<string>();
        validatedIssues = validatedIssues.filter((iss) => {
          if (!iss.issue_id) return true;
          if (seen.has(iss.issue_id)) {
            console.log(`[API] Removing duplicate id after validation: ${iss.issue_id}`);
            return false;
          }
          seen.add(iss.issue_id);
          return true;
        });
      } catch (e) {
        console.error(`[API] Validation failed, using all retrieved issues:`, e);
        // Fallback: use all retrieved issues if validation fails
      }
    }

    const messages = useCompany
      ? buildCompanyGroundedMessages(url, goal, validatedIssues, suppressedIssues)
      : buildGenericMessages(url, goal);

    const prompt = `${formatMessagesForResponses(messages)}${crawlContext}`;

    const apiKey = process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
      return NextResponse.json({
        report: SAMPLE_REPORT,
        retrievedIssues: retrieved,
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

