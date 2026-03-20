import { type Issue } from "./ux";

// ─────────────────────────────────────────────────────────────────────────────
// buildDynamicSystemPrompt
//
// Builds the system prompt for the main audit LLM call dynamically from the
// retrieved issue library.  Each issue's signals_to_detect, negative_signals,
// visual_confirmation_required, and page_type are injected at runtime — nothing
// is hardcoded.  The caller supplies all variable data; the prompt just formats
// it into structured instructions for the model.
// ─────────────────────────────────────────────────────────────────────────────

export interface DynamicPromptContext {
    siteType: string;
    retrievedIssues: Issue[];
    applicableCount: number;
    screenshotCount: number;
    url: string;
    goal: string;
}

/**
 * Renders a single issue from the library as a numbered prompt block.
 * Uses the issue's own signals — no hardcoded detection rules.
 */
function renderEnhancedIssueBlock(issue: Issue, idx: number): string {
    const signals = Array.isArray((issue as any).signals_to_detect)
        ? (issue as any).signals_to_detect as string[]
        : [];
    const negativeSignals = Array.isArray((issue as any).negative_signals)
        ? (issue as any).negative_signals as string[]
        : [];
    const pageTypes = Array.isArray(issue.page_type)
        ? issue.page_type.join(", ")
        : String(issue.page_type ?? "all");
    const visualRequired = Boolean((issue as any).visual_confirmation_required);
    
    const detectionExplain = (issue as any).detection_type === 'absence'
        ? '⚠️ Flag if signals are MISSING'
        : '✓ Flag if signals ARE PRESENT';
    
    return `${idx + 1}. ${issue.issue_id ?? "??"}: ${issue.issue_title ?? "Untitled"}
   Severity: ${issue.severity ?? "Unknown"} | Page: ${pageTypes}
   
   SIGNALS TO DETECT:
${signals.length > 0 ? signals.map(s => `   • ${s}`).join('\n') : '   • Use general UX principles'}
   
   NEGATIVE SIGNALS (if ANY found, SKIP this issue):
${negativeSignals.length > 0 ? negativeSignals.map(s => `   • ${s}`).join('\n') : '   • None'}
   
   Detection: ${(issue as any).detection_type ?? "presence"} ${detectionExplain}
   Visual Required: ${visualRequired ? 'YES - must see in screenshot' : 'NO - can infer'}
   
   User Problem: ${issue.user_problem ?? ""}
   Fix: ${issue.recommendation ?? ""}`;
}

/**
 * Builds a fully dynamic system prompt from the retrieved issue library.
 * The detection methodology is driven entirely by each issue's own signals.
 *
 * Returns a string ready to be used as the "system" message in the LLM call.
 */
export function buildDynamicSystemPrompt(context: DynamicPromptContext): string {
    const {
        siteType,
        retrievedIssues,
        applicableCount,
        screenshotCount,
        url,
        goal,
    } = context;

    // Calculate dynamic minimums
    const minIssues = Math.floor(context.retrievedIssues.length * 0.5);
    const maxIssues = Math.floor(context.retrievedIssues.length * 0.8);
    const perScreenshotMin = Math.floor(context.screenshotCount * 3);
    const perScreenshotMax = Math.floor(context.screenshotCount * 5);
    
    return `You are a UX Auditor for Digital of Things auditing a ${siteType} website.

═══════════════════════════════════════════════════════════════
AUDIT CONTEXT
═══════════════════════════════════════════════════════════════

Website: ${url}
Site Type: ${siteType}
Goal: ${goal}
Screenshots: ${screenshotCount}
Issues to Analyze: ${retrievedIssues.length} (pre-filtered and validated from ${applicableCount} applicable)

═══════════════════════════════════════════════════════════════
CRITICAL: SYSTEMATIC ANALYSIS REQUIRED
═══════════════════════════════════════════════════════════════

You MUST evaluate EVERY ONE of the ${retrievedIssues.length} issues below.

For EACH issue:
1. READ its "SIGNALS TO DETECT"
2. EXAMINE screenshots/crawl for those signals
3. CHECK "NEGATIVE SIGNALS" (if any present, skip issue)
4. DOCUMENT: present / absent / uncertain

MINIMUM REQUIREMENT:
Find at least ${minIssues} to ${maxIssues} HIGH or MEDIUM confidence issues.

If you find fewer than ${minIssues}, you have NOT been systematic.

═══════════════════════════════════════════════════════════════
EVIDENCE HIERARCHY
═══════════════════════════════════════════════════════════════

1. SCREENSHOTS (highest priority)
   • If visual_confirmation_required = true, MUST see in screenshot
   
2. CRAWL DATA (secondary)
   • DOM structure, text, meta tags
   
3. INFERENCE (last resort)
   • Mark as "Low confidence" or "Requires verification"

═══════════════════════════════════════════════════════════════
ISSUE LIBRARY (${retrievedIssues.length} ISSUES)
═══════════════════════════════════════════════════════════════

${retrievedIssues.map((issue, idx) => renderEnhancedIssueBlock(issue, idx)).join('\n\n')}

═══════════════════════════════════════════════════════════════
SCREENSHOT-BY-SCREENSHOT ANALYSIS (${screenshotCount} SCREENSHOTS)
═══════════════════════════════════════════════════════════════

For EACH screenshot:

a) Identify page type
b) Filter applicable issues (by page_type match)
c) Check EACH applicable issue's signals
d) Document findings

MINIMUM: ${perScreenshotMin} to ${perScreenshotMax} issues total across all screenshots
(${screenshotCount > 0 ? Math.floor(perScreenshotMin / screenshotCount) : 0} to ${screenshotCount > 0 ? Math.floor(perScreenshotMax / screenshotCount) : 0} per screenshot)

═══════════════════════════════════════════════════════════════
PRE-SUBMISSION VALIDATION
═══════════════════════════════════════════════════════════════

BEFORE finalizing, verify:

□ I evaluated ALL ${retrievedIssues.length} issues
□ I examined ALL ${screenshotCount} screenshots
□ I found at least ${minIssues} HIGH/MEDIUM confidence issues
□ Current count: ___ (must be ≥ ${minIssues})
□ Findings show diversity (not clustered around one pattern)
□ Every finding has evidence (screenshot or crawl reference)

If ANY checkbox fails, continue analyzing before finalizing.

═══════════════════════════════════════════════════════════════
YOUR TASK
═══════════════════════════════════════════════════════════════

Systematically analyze all ${retrievedIssues.length} issues against 
${screenshotCount} screenshots and crawl data.

Target: ${minIssues}-${maxIssues} comprehensive findings.

Begin your analysis using the issue library and detection framework above.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildDynamicUserPrompt
//
// The user-turn complement to buildDynamicSystemPrompt.  Kept separate so it
// can be updated independently from the system prompt.
// ─────────────────────────────────────────────────────────────────────────────

export function buildDynamicUserPrompt(
    url: string,
    goal: string,
    hasScreenshots: boolean
): string {
    return `Audit the following website using the UX Issue Library and detection framework provided in the system prompt.

URL: ${url}
Primary Goal: ${goal}

Instructions:
• Create an experience-led audit. Include ONLY issues you actually see in evidence (screenshots first, then crawl).
• Every finding in the journey sections MUST reference a library UX-### ID.
• ${hasScreenshots ? "Screenshots are attached — treat them as primary evidence. Base findings on what you can observe directly." : "No screenshots provided — base findings on crawl excerpts only. Label uncertain findings as \"Needs verification\"."}
• Prioritise screenshot evidence over crawl: for cart, checkout, PDP, and any page shown in screenshots, use what the screenshots show; crawl is secondary.
• Separate confirmed (visible in evidence) vs \"Needs verification\" when evidence is partial.
• Aim to cover the key conversion paths: home → category → product → cart → checkout (when present).
• For action-dependent flows (add-to-cart, authentication, form submission, checkout), if the crawl cannot perform the action, use: "Not observable via crawl — Requires manual verification".
• End with: "Where a manual UX audit should focus next".`;
}
