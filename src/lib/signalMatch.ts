import type { Issue } from './ux'; // import whatever the Issue type is called in ux.ts

export type SignalMatchResult = {
  issue_id: string;
  matched_signals: string[];
  score: number; // 0.0 – 1.0
  is_absence_issue: boolean;
  suppressed: boolean;
  suppression_reason?: string;
};

/**
 * Deterministically checks whether an issue's signals_to_detect[] are present
 * in the crawl text + screenshot OCR text. Replaces validateIssuesWithLLM()
 * for all issues where screenshot-only visual judgment is not required.
 *
 * Rules:
 * 1. Check negative_signals first — if any match, suppress immediately
 * 2. For each signal in signals_to_detect[], tokenise and check ≥50% term overlap
 * 3. Final score = matched_signals.length / total_signals (0 = no match, 1 = all matched)
 * 4. Absence issues (detection_type === "absence") are included when score === 0
 *    AND the page type is confirmed present in the evidence text
 */

const PAGE_TYPE_URL_PATTERNS: Record<string, RegExp> = {
  checkout: /\/(checkout|order|payment)/i,
  cart: /\/(cart|bag|basket)/i,
  product: /\/(product|p\/|item|pdp)/i,
  homepage: /^https?:\/\/[^/]+\/?$/i,
  category: /\/(category|collection|shop|browse|c\/)\//i,
};

export function deterministicSignalCheck(
  issue: Issue,
  crawlText: string,
  screenshotOcrText: string
): SignalMatchResult {
  const haystack = `${crawlText} ${screenshotOcrText}`.toLowerCase();
  const signals: string[] = issue.signals_to_detect ?? [];
  const negSignals: string[] = (issue as any).negative_signals ?? [];
  const isAbsence = (issue as any).detection_type === 'absence';

  // Step 1: Check negative signals — any match → suppress
  for (const neg of negSignals) {
    const terms = neg.toLowerCase().match(/\b[a-z0-9]{3,}\b/g) ?? [];
    if (terms.length === 0) continue;
    const hitCount = terms.filter((t) => haystack.includes(t)).length;
    if (hitCount / terms.length >= 0.5) {
      return {
        issue_id: issue.issue_id ?? '',
        matched_signals: [],
        score: 0,
        is_absence_issue: isAbsence,
        suppressed: true,
        suppression_reason: `Negative signal matched: "${neg}"`,
      };
    }
  }

  // Step 2: Match positive signals
  const matched: string[] = [];
  for (const sig of signals) {
    const terms = sig.toLowerCase().match(/\b[a-z0-9]{3,}\b/g) ?? [];
    if (terms.length === 0) continue;
    const hitCount = terms.filter((t) => haystack.includes(t)).length;
    if (hitCount / terms.length >= 0.5) {
      matched.push(sig);
    }
  }

  const score = signals.length > 0 ? matched.length / signals.length : 0;

  // Step 3: Absence issues — include when the relevant page is present but the feature is absent
  if (isAbsence) {
    const pageTypes: string[] = (issue as any).page_type ?? [];
    const pageTypeConfirmed = pageTypes.some((pt) => {
      const ptLower = pt.toLowerCase();
      return (
        haystack.includes(ptLower) ||
        (issue as any).page_url?.toLowerCase().includes(ptLower) ||
        PAGE_TYPE_URL_PATTERNS[ptLower]?.test((issue as any).page_url ?? '')
      );
    });
    const featureAbsent = score === 0; // no positive signals found = feature is missing
    if (pageTypeConfirmed && featureAbsent) {
      return {
        issue_id: issue.issue_id ?? '',
        matched_signals: [],
        score: 0.8, // absence confirmed — assign fixed confidence
        is_absence_issue: true,
        suppressed: false,
      };
    } else if (!pageTypeConfirmed) {
      return {
        issue_id: issue.issue_id ?? '',
        matched_signals: [],
        score: 0,
        is_absence_issue: true,
        suppressed: true,
        suppression_reason: 'Page type not confirmed in crawl or screenshot evidence',
      };
    }
  }

  // Step 4: Presence issues — suppress if no signals matched
  if (score === 0 && !isAbsence) {
    return {
      issue_id: issue.issue_id ?? '',
      matched_signals: [],
      score: 0,
      is_absence_issue: false,
      suppressed: true,
      suppression_reason: 'No positive signals matched in crawl or screenshot text',
    };
  }

  return {
    issue_id: issue.issue_id ?? '',
    matched_signals: matched,
    score,
    is_absence_issue: isAbsence,
    suppressed: false,
  };
}
