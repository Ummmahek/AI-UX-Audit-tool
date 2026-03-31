import { type Issue } from "./ux";

export function buildDynamicSystemPrompt(context: {
  siteType: string;
  retrievedIssues: Issue[];
  applicableCount: number;
  screenshotCount: number;
  url: string;
  goal: string;
  crawlSuccess: boolean;
}) {
  
  // Calculate minimums
  let minIssues: number;
  if (context.crawlSuccess) {
    minIssues = Math.max(20, Math.floor(context.retrievedIssues.length * 0.5));
  } else if (context.screenshotCount > 0) {
    minIssues = Math.max(15, context.screenshotCount * 4);
  } else {
    minIssues = 5;
  }
  
  const maxIssues = Math.floor(minIssues * 1.6);

  return `You are analyzing ${context.url} (a ${context.siteType} website) for UX issues.

CONTEXT:
- Site Type: ${context.siteType}
- Screenshots: ${context.screenshotCount} provided
- Crawl Data: ${context.crawlSuccess ? 'Available' : 'Limited - rely on screenshots'}
- Issues to Check: ${context.retrievedIssues.length}
- Your Goal: ${context.goal}

═══════════════════════════════════════════════════════════════
ISSUE LIBRARY (${context.retrievedIssues.length} ISSUES TO CHECK)
═══════════════════════════════════════════════════════════════

${context.retrievedIssues.map((issue, idx) => `
${idx + 1}. ${issue.issue_id}: ${(issue as any).issue_title || (issue as any).title || 'Untitled'}
   Severity: ${issue.severity}
   Page Type: ${Array.isArray(issue.page_type) ? issue.page_type.join(', ') : issue.page_type}
   Detection: ${(issue as any).detection_type || 'presence'}
   
   Signals to Detect:
${(Array.isArray(issue.signals_to_detect) ? issue.signals_to_detect : []).map((s: string) => `   - ${s}`).join('\n') || '   - Use general UX principles'}
   
   Negative Signals (if ANY present, SKIP this issue):
${(Array.isArray((issue as any).negative_signals) ? (issue as any).negative_signals : []).map((s: string) => `   - ${s}`).join('\n') || '   - None'}
   
   User Problem: ${(issue as any).user_problem || "UX consideration"}
   Fix: ${issue.recommendation}
`).join('\n')}

═══════════════════════════════════════════════════════════════
ANALYSIS INSTRUCTIONS
═══════════════════════════════════════════════════════════════

1. SYSTEMATIC CHECKING
   Check EVERY issue above systematically:
   - Read the signals to detect
   - Look for those signals in screenshots and crawl data
   - Check for negative signals - if ANY present, skip that issue
   - If signals found and no negative signals → report it

2. SCREENSHOT ANALYSIS ${context.screenshotCount > 0 ? `(${context.screenshotCount} provided)` : ''}
   ${context.screenshotCount > 0 ? `
   Examine each screenshot thoroughly:
   - Check what's visible: navigation, content, forms, buttons, layout
   - Look for both presence issues (unwanted elements) AND absence issues (missing elements)
   - Find 4-5 issues per screenshot minimum
   - Target: ${Math.floor(context.screenshotCount * 4)} total issues from screenshots
   
   Common checks per screenshot:
   - Navigation: breadcrumbs, search, menu complexity, language selector
   - Content: contrast, text density, hierarchy, clarity
   - Forms: labels, grouping, required fields, validation messages
   - Layout: spacing, alignment, consistency
   - Information: pricing, contact info, policies, trust signals
   ` : 'No screenshots provided - use crawl data only'}

3. SITE TYPE AWARENESS
   This is a ${context.siteType} site:
   ${context.siteType === 'ecommerce' ? '- Focus on product pages, cart, checkout flow' : ''}
   ${context.siteType === 'real_estate' ? '- Focus on property listings, forms, contact info, NOT checkout/cart' : ''}
   ${context.siteType === 'saas' ? '- Focus on signup, dashboard, pricing pages' : ''}
   ${context.siteType === 'corporate' ? '- Focus on navigation, content clarity, contact forms' : ''}
   
   DO NOT report checkout/cart issues unless this is an ecommerce site.

4. EVIDENCE REQUIREMENTS
   Every finding MUST have specific evidence:
   ${context.screenshotCount > 0 ? '- Reference screenshot number and element location' : ''}
   - Example: "Screenshot 2 shows header navigation: no search icon visible"
   - Example: "Crawl data shows 14 images with missing alt text"
   - NO vague claims like "site has issues"

5. MINIMUM REQUIREMENTS
   Find at least ${minIssues} HIGH or MEDIUM confidence issues
   Maximum ${maxIssues} issues
   
   If you're below minimum, re-examine screenshots more carefully.

═══════════════════════════════════════════════════════════════
REPORT FORMAT
═══════════════════════════════════════════════════════════════

For each confirmed issue:

**[ISSUE_ID]: [Title from library]**

Detection: present | absent | not applicable
Confidence: High | Medium | Low
Evidence: [Screenshot X shows specific element/location: observation] OR [Crawl data shows: finding]

Signals to Detect:
[List each signal with Present/Not observable/Negative signal found]

User Problem: [From library]
Recommendation: [From library]

═══════════════════════════════════════════════════════════════
PRE-SUBMISSION CHECKLIST
═══════════════════════════════════════════════════════════════

□ Checked all ${context.retrievedIssues.length} issues systematically
□ Examined all ${context.screenshotCount} screenshots thoroughly
□ Found at least ${minIssues} HIGH/MEDIUM confidence issues (current count: ___)
□ Every finding has specific evidence (screenshot X or crawl data)
□ No checkout/cart issues reported (unless site is ecommerce)
□ No duplicate issues
□ Findings are diverse (not all navigation or all forms)

═══════════════════════════════════════════════════════════════

Analyze the site now and report ${minIssues}-${maxIssues} confirmed issues.`;
}

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
