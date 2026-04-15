import { type Issue } from "./ux";

export function buildDynamicSystemPrompt(context: {
  siteType: string;
  finalIssues: any[];
  applicableCount: number;
  screenshotCount: number;
  url: string;
  goal: string;
  crawlSuccess: boolean;
  playwrightUsed: boolean;
  dataQuality: string;
}) {
  
  return `You are writing a UX audit report for ${context.url} (a ${context.siteType} website).

CONTEXT:
- Site Type: ${context.siteType}
- Screenshots: ${context.screenshotCount} provided
- Crawl Data: ${context.crawlSuccess ? 'Available' : 'Limited'}
- Playwright Used: ${context.playwrightUsed ? 'Yes' : 'No'}
- Data Quality: ${context.dataQuality}
- Issues to Check: ${context.finalIssues.length}
- Your Goal: ${context.goal}

═══════════════════════════════════════════════════════════════
FINAL ISSUE LIST (${context.finalIssues.length} ISSUES)
═══════════════════════════════════════════════════════════════

${context.finalIssues.map((issue, idx) => `
${idx + 1}. ${issue.issue_id}: ${issue.title}
   Confidence: ${issue.confidence}
   UX Impact: ${issue.ux_impact}
   Cluster: ${issue.cluster}
   Journey Stage: ${issue.journey_stage}
   Evidence Summary: ${issue.evidence_summary}
   Recommendation: ${issue.recommendation}
`).join('\n')}

═══════════════════════════════════════════════════════════════
REPORT FORMAT & INSTRUCTIONS
═══════════════════════════════════════════════════════════════

1. FINAL VALIDATED ISSUES
   Write the report strictly from this final validated list. Do not revalidate these issues. Do NOT add new issues, and do NOT remove or suppress any visually mapped issues that have already survived the pipeline. Use the exact issue IDs provided.
   
2. EVIDENCE REQUIREMENTS
   Every finding MUST have specific evidence, using the "Evidence Summary" provided.
   - Example: "Screenshot 2 shows header navigation: no search icon visible"
   - Example: "Crawl data shows 14 images with missing alt text"
   - NO vague claims like "site has issues"

3. SITE TYPE AWARENESS
   This is a ${context.siteType} site:
   ${context.siteType === 'ecommerce' ? '- Focus on product pages, cart, checkout flow' : ''}
   ${context.siteType === 'real_estate' ? '- Focus on property listings, forms, contact info, NOT checkout/cart' : ''}
   ${context.siteType === 'saas' ? '- Focus on signup, dashboard, pricing pages' : ''}
   ${context.siteType === 'corporate' ? '- Focus on navigation, content clarity, contact forms' : ''}

═══════════════════════════════════════════════════════════════
REPORT FORMAT
═══════════════════════════════════════════════════════════════

Always start the output with the following structure:

# [Site Name] — UX Audit Report

**Site:** ${context.url}  
**Type:** ${context.siteType}  
**Goal:** ${context.goal}  
**Data Quality:** ${context.dataQuality}  
**Issues Found:** [Total Count]

---

## Executive Summary
[2–3 sentence overview of most critical UX gaps]

---

## Journey Stage Findings

### Stage: [Discovery / Evaluation / Action / Retention]

For each confirmed issue in this stage:

#### [ISSUE_ID] — [Title from library]
**Confidence:** Confirmed | Likely | Possible  
**UX Impact:** High | Medium | Low  
**Evidence:** [Screenshot X / Crawl: specific observation]  
**User Problem:** [From library]  
**Recommendation:** [From library]  

---

## Issues by Cluster

Create a compact summary grouping your final selected issues by their cluster.
- Only show clusters that contain at least 1 selected issue. Do not print empty cluster headers.
- Format the output strictly as a concise index, for example:
  * Conversion: UX-003, UX-006, UX-007, DET-010
  * Accessibility: UX-011, DET-003
- Do not repeat issue titles, descriptions, evidence, or recommendations. This section should only summarize and index. No empty filler text.
- If cluster coverage is sparse or concentrated, add a single one-line note at the end. Example: "Most issues concentrated in Conversion and Accessibility for this audit."

---

## Coverage & Limitations
[Explain what flows (e.g. checkout, auth) could not be observed via automated crawl/screenshots]

═══════════════════════════════════════════════════════════════
PRE-SUBMISSION CHECKLIST
═══════════════════════════════════════════════════════════════

□ Checked all ${context.finalIssues.length} issues systematically
□ Every finding has specific evidence (screenshot X or crawl data)
□ Assessed confidence as Confirmed, Likely, or Possible
□ Applied strict anti-padding rule (no fluff issues)
□ No checkout/cart issues reported (unless site is ecommerce)
□ No duplicate issues

═══════════════════════════════════════════════════════════════

Analyze the site now and output the structured report.`;
}

export function buildDynamicUserPrompt(
    url: string,
    goal: string,
    hasScreenshots: boolean
): string {
    return `Create the final UX audit report using the provided validated issue list.

URL: ${url}
Primary Goal: ${goal}

Instructions:
• Create an experience-led audit using the required structured format (Journey Stage -> Cluster Summary -> Limitations).
• Every finding MUST belong to the final issue list.
• DO NOT add, remove, or suppress ANY issues from the final list. Do not revalidate them or hide visually mapped issues.
• Map your findings to the Journey Stages (Discovery, Evaluation, Action, Retention) based on the provided list.
• Ensure issues are categorised correctly under their respective Clusters based on the provided list.
• Use the 'Evidence Summary' directly from the issue list for the 'Evidence' segment.
• For action-dependent flows, if the crawl cannot perform the action, cover it under "Coverage & Limitations".`;
}
