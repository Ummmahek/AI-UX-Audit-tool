import type { Issue } from './ux'; // import whatever the Issue type is called in ux.ts

export type SignalMatchResult = {
  issue_id: string;
  matched_signals: string[];
  score: number; // Represents evidenceStrength: 1.0 (strong), 0.6 (weak), 0.3 (none)
  negPenaltyFactor: number; // 0.4 for partial negative match, 1.0 otherwise
  is_absence_issue: boolean;
  suppressed: boolean;
  suppression_reason?: string;
  /** True when the issue was not suppressed but scored low due to weak/missing signals */
  penalized?: boolean;
  penaltyReason?: string;
  /** The raw keyword score from retrieval step (passed through for recovery pass eligibility) */
  keywordScore?: number;
};

/**
 * Deterministically checks whether an issue's signals_to_detect[] are present
 * in the crawl text + screenshot OCR text.
 *
 * Change 1: Replaces hard suppression with a penalty-scoring model.
 *
 * Rules:
 * 1. Explicit contradiction check — if negative signal term overlap ≥80% AND
 *    positive signal overlap <20% → hard suppress (only true contradictions).
 * 2. Negative signal partial match (≥50% terms) → strong score penalty (×0.4), NOT suppress.
 * 3. No positive signals matched → low score (0.15), penalized=true, NOT suppress.
 * 4. Weak positive match (1 signal) → mild penalty (×0.75).
 * 5. Absence issues (detection_type === "absence") → keep existing positive logic.
 */

const PAGE_TYPE_URL_PATTERNS: Record<string, RegExp> = {
  checkout: /\/(checkout|order|payment)/i,
  cart: /\/(cart|bag|basket)/i,
  product: /\/(product|p\/|item|pdp)/i,
  homepage: /^https?:\/\/[^/]+\/?$/i,
  category: /\/(category|collection|shop|browse|c\/)\//i,
};

/** Compute term overlap ratio between a phrase and a haystack. */
function termOverlap(phrase: string, haystack: string): number {
  const terms = phrase.toLowerCase().match(/\b[a-z0-9]{3,}\b/g) ?? [];
  if (terms.length === 0) return 0;
  const hits = terms.filter((t) => haystack.includes(t)).length;
  return hits / terms.length;
}

export function deterministicSignalCheck(
  issue: Issue,
  crawlText: string,
  screenshotOcrText: string,
  keywordScore?: number,
): SignalMatchResult {
  const haystack = `${crawlText} ${screenshotOcrText}`.toLowerCase();
  const signals: string[] = issue.signals_to_detect ?? [];
  const negSignals: string[] = (issue as any).negative_signals ?? [];
  const isAbsence = (issue as any).detection_type === 'absence';

  // ── Step 1: Negative signal analysis ──────────────────────────────────────
  let negPenaltyFactor = 1.0;
  let explicitContradiction = false;

  for (const neg of negSignals) {
    const negOverlap = termOverlap(neg, haystack);
    if (negOverlap < 0.5) continue; // below 50%: not a real match

    // Compute positive overlap to detect explicit contradiction
    // (negative signal clearly present AND positive evidence essentially absent)
    const posSignalOverlaps = signals.map((s) => termOverlap(s, haystack));
    const maxPosOverlap = posSignalOverlaps.length > 0
      ? Math.max(...posSignalOverlaps)
      : 0;

    if (negOverlap >= 0.8 && maxPosOverlap < 0.2) {
      // Hard contradiction: the thing that would disprove the issue is clearly
      // present and there is essentially no positive evidence for the issue.
      explicitContradiction = true;
      return {
        issue_id: issue.issue_id ?? '',
        matched_signals: [],
        score: 0.3, // "none" evidence baseline
        negPenaltyFactor: 1.0, // Suppressed anyway
        is_absence_issue: isAbsence,
        suppressed: true,
        suppression_reason: `Explicit contradiction: negative signal "${neg}" strongly present (${Math.round(negOverlap * 100)}% term overlap) with minimal positive evidence (${Math.round(maxPosOverlap * 100)}%)`,
        keywordScore,
      };
    }

    // Partial negative match: apply a strong score penalty (×0.4) but do NOT suppress.
    if (negOverlap >= 0.5) {
      negPenaltyFactor = Math.min(negPenaltyFactor, 0.4);
    }
  }

  // ── Step 2: Match positive signals ────────────────────────────────────────
  const matched: string[] = [];
  for (const sig of signals) {
    if (termOverlap(sig, haystack) >= 0.5) {
      matched.push(sig);
    }
  }

  // ── Step 3: Absence issues ────────────────────────────────────────────────
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
    const featureAbsent = matched.length === 0; // no positive signals found = feature is missing
    if (pageTypeConfirmed && featureAbsent) {
      return {
        issue_id: issue.issue_id ?? '',
        matched_signals: [],
        score: 1.0, // Full evidence for absence issue
        negPenaltyFactor, 
        is_absence_issue: true,
        suppressed: false,
        keywordScore,
      };
    } else if (!pageTypeConfirmed) {
      return {
        issue_id: issue.issue_id ?? '',
        matched_signals: [],
        score: 0.3,
        negPenaltyFactor: 1.0,
        is_absence_issue: true,
        suppressed: true,
        suppression_reason: 'Page type not confirmed in crawl or screenshot evidence',
        keywordScore,
      };
    }
  }

  // ── Step 4: Presence issues — evidenceStrength mapping ──
  
  let evidenceStrength = 0.3; // Default none
  let penalized = false;
  let penaltyReason: string | undefined;

  if (matched.length >= 2 || (matched.length === 1 && signals.length === 1)) {
    evidenceStrength = 1.0; // Strong
  } else if (matched.length === 1 && signals.length > 1) {
    evidenceStrength = 0.6; // Weak
    penalized = true;
    penaltyReason = `Only 1 of ${signals.length} signals matched (weak evidence)`;
  } else if (matched.length === 0 && !isAbsence) {
    evidenceStrength = 0.3; // None
    penalized = true;
    penaltyReason = 'No positive signals matched in crawl or screenshot text';
  }

  if (negPenaltyFactor < 1.0) {
    penalized = true;
    penaltyReason = `${penaltyReason ? penaltyReason + '; ' : ''}Negative signal partial match applied penalty ×${negPenaltyFactor}`;
  }

  return {
    issue_id: issue.issue_id ?? '',
    matched_signals: matched,
    score: evidenceStrength, // Pass un-penalized evidence component
    negPenaltyFactor,
    is_absence_issue: isAbsence,
    suppressed: false,
    penalized,
    penaltyReason,
    keywordScore,
  };
}
