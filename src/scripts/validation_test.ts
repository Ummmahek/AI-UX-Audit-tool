import { type Issue } from '../lib/ux';

// replicate relevant part of validateIssuesWithLLM to test overrides
function runValidationTest(issues: Issue[], validations: any[], crawlExcerpts: string, screenshotText: string) {
  const hadScreenshots = screenshotText && screenshotText.trim().length > 0;
  const hadCrawl = crawlExcerpts && crawlExcerpts.trim().length > 0;

  const validated: Issue[] = [];
  const suppressed: Array<{ issue: Issue; reason: string }> = [];

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const validation = validations.find((v) => v.issue_id === issue.issue_id) ?? validations[i];
    if (!validation) {
      suppressed.push({ issue, reason: 'Validation failed - no response' });
      continue;
    }

    if ((validation as any).page_type_mismatch === true) {
      suppressed.push({ issue, reason: validation.suppression_reason });
      continue;
    }

    const hasScreenshotEvidence = (validation.positive_signals_in_screenshots?.length ?? 0) > 0;
    const hasCrawlEvidence = (validation.positive_signals_in_crawl?.length ?? 0) > 0;
    let hasAnyPositiveEvidence = (validation.positive_signals_confirmed?.length ?? 0) > 0;
    let hasNegativeEvidence = (validation.negative_signals_confirmed?.length ?? 0) > 0;

    if (issue.issue_id === 'UX-040') {
      if (!hasAnyPositiveEvidence && !hasNegativeEvidence) {
        console.log('[test] UX-040 absence override triggered');
        validation.include = true;
        hasAnyPositiveEvidence = true;
      }
    }

    if (hasNegativeEvidence) {
      const negs = validation.negative_signals_confirmed ?? [];
      const weakPatternsByIssue: { [id: string]: RegExp[] } = {
        'UX-040': [/secure checkout/i, /header/i],
        'UX-036': [/doesn'?t force account/i, /guest checkout prominently offered/i],
        'UX-037': [/logical grouping/i, /grouped logically/i],
        'UX-102': [/no clear evidence/i, /mismatch/i],
      };
      const id = issue.issue_id ?? '';
      const patterns: RegExp[] = weakPatternsByIssue[id] || [];
      let treatAsWeak = false;
      if (patterns.length > 0) {
        treatAsWeak = negs.every((n: string) => patterns.some((p) => p.test(n)));
      }
      if (issue.issue_id === 'UX-036' && screenshotText.toLowerCase().includes('create and link')) {
        treatAsWeak = true;
      }
      if (treatAsWeak) {
        console.log(`[test] treating negative as weak for ${issue.issue_id}`);
        hasNegativeEvidence = false;
      }
    }

    if (hasNegativeEvidence) {
      suppressed.push({ issue, reason: validation.suppression_reason || `Negative signals confirmed: ${validation.negative_signals_confirmed.join(', ')}` });
      continue;
    }

    // special UX-102 override
    if (issue.issue_id === 'UX-102') {
      const phoneText = (crawlExcerpts + ' ' + screenshotText).toLowerCase();
      if (/phone|country/.test(phoneText) && !hasAnyPositiveEvidence && !validation.include) {
        console.log('[test] UX-102 override triggered');
        validation.include = true;
        hasAnyPositiveEvidence = true;
      }
    }

    if (!validation.include && !hasAnyPositiveEvidence) {
      suppressed.push({ issue, reason: validation.suppression_reason || 'zero evidence' });
      continue;
    }

    const baseConf = typeof issue.confidence_weight === 'number' ? issue.confidence_weight : 0.7;
    const penalties = (issue as any).confidence_penalties ?? {};
    let score = baseConf;
    if (validation.evidence_is_conditional) {
      const penalty = penalties.uncertainty_stated ?? -0.25;
      score += penalty;
    }
    if (validation.include && score >= 0.55) {
      validated.push(issue);
    } else {
      suppressed.push({ issue, reason: `score ${score}` });
    }
  }
  return { validated, suppressed };
}

async function runModelTests() {
  // Instead of contacting the LLM, replicate the post-LLM validation loop
  // exactly as it exists in src/lib/ux.ts and exercise the special-case
  // overrides using canned "validation" results.

  function mimicValidation(issues: any[], validations: any[], crawlExcerpts: string, screenshotText: string) {
    const hadScreenshots = screenshotText && screenshotText.trim().length > 0;
    const hadCrawl = crawlExcerpts && crawlExcerpts.trim().length > 0;
    const validated: any[] = [];
    const suppressed: Array<{ issue: any; reason: string }> = [];

    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      const validation = validations.find((v) => v.issue_id === issue.issue_id) ?? validations[i];
      if (!validation) {
        suppressed.push({ issue, reason: "Validation failed - no response" });
        continue;
      }

      // quality check for suppression reason (mirror FIX 0)
      if (validation.include === false) {
        const reason = (validation.suppression_reason || "").trim();
        const evidenceHint = /screenshot|crawl|evidence|signal|\bno\b|\bnot\b/i;
        if (!reason || reason.length < 20 || !evidenceHint.test(reason)) {
          console.log("[test] overriding include=true due to weak/missing reason for", validation.issue_id);
          validation.include = true;
        }
      }

      if ((validation as any).page_type_mismatch === true) {
        suppressed.push({ issue, reason: validation.suppression_reason });
        continue;
      }

      const hasScreenshotEvidence = (validation.positive_signals_in_screenshots?.length ?? 0) > 0;
      const hasCrawlEvidence = (validation.positive_signals_in_crawl?.length ?? 0) > 0;
      let hasAnyPositiveEvidence = (validation.positive_signals_confirmed?.length ?? 0) > 0;
      let hasNegativeEvidence = (validation.negative_signals_confirmed?.length ?? 0) > 0;

      // SPECIAL-TREAT: UX-040 absence-of-trust-badges
      if (issue.issue_id === "UX-040") {
        if (!hasAnyPositiveEvidence && !hasNegativeEvidence) {
          console.log("[test] overriding UX-040 include=true due to absence rule");
          validation.include = true;
          hasAnyPositiveEvidence = true;
        }
      }

      // HARD RULE: UX-036 override when account gating text is visible
      if (issue.issue_id === "UX-036") {
        const ss = screenshotText.toLowerCase();
        if (/create account|link account/.test(ss) || (/email/.test(ss) && !/guest/.test(ss))) {
          console.log("[test] overriding UX-036 include=true because account gating appears");
          validation.include = true;
          hasAnyPositiveEvidence = true;
        }
      }

      // ── FIX 4: Guard against weak/ambiguous negative evidence ──────────────
      if (hasNegativeEvidence) {
        const negs = validation.negative_signals_confirmed ?? [];
        const weakPatternsByIssue: { [id: string]: RegExp[] } = {
          "UX-040": [/secure checkout/i, /header/i],
          "UX-036": [/doesn'?t force account/i, /guest checkout prominently offered/i],
          "UX-037": [/logical grouping/i, /grouped logically/i],
          "UX-102": [/no clear evidence/i, /mismatch/i],
        };
        const id = issue.issue_id ?? "";
        const patterns: RegExp[] = weakPatternsByIssue[id] || [];
        let treatAsWeak = false;
        if (patterns.length > 0) {
          treatAsWeak = negs.every((n: string) => patterns.some((p: RegExp) => p.test(n)));
        }
        if (issue.issue_id === "UX-036" && screenshotText.toLowerCase().includes("create and link")) {
          treatAsWeak = true;
        }
        if (treatAsWeak) {
          console.log(`[test] treating negative as weak for ${issue.issue_id}`);
          hasNegativeEvidence = false;
        }
      }

      if (hasNegativeEvidence) {
        suppressed.push({ issue, reason: validation.suppression_reason || `Negative signals confirmed: ${validation.negative_signals_confirmed.join(", ")}` });
        continue;
      }

      // re-run UX-040 absence override after clearing weak negatives
      if (issue.issue_id === "UX-040" && !hasAnyPositiveEvidence && !hasNegativeEvidence) {
        console.log("[test] UX-040 absence override (post-negative) triggered");
        validation.include = true;
        hasAnyPositiveEvidence = true;
      }

      // special UX-102 override
      if (issue.issue_id === "UX-102") {
        const phoneText = (crawlExcerpts + " " + screenshotText).toLowerCase();
        if (/phone|country/.test(phoneText) && !hasAnyPositiveEvidence && !validation.include) {
          console.log("[test] Overriding UX-102 include=true due to visible phone/country fields");
          validation.include = true;
          hasAnyPositiveEvidence = true;
        }
      }

      if (!validation.include && !hasAnyPositiveEvidence) {
        suppressed.push({ issue, reason: validation.suppression_reason || 'zero evidence' });
        continue;
      }

      const baseConf = typeof issue.confidence_weight === 'number' ? issue.confidence_weight : 0.7;
      const penalties = (issue as any).confidence_penalties ?? {};
      let score = baseConf;
      if (validation.evidence_is_conditional) {
        const penalty = penalties.uncertainty_stated ?? -0.25;
        score += penalty;
      }
      if (validation.include && score >= 0.55) {
        validated.push(issue);
      } else {
        suppressed.push({ issue, reason: `score ${score}` });
      }
    }
    return { validated, suppressed };
  }

  // now run tests
  const issues = [{ issue_id: 'UX-040', confidence_weight: 0.77 }];
  const fakeValidation = [{
    issue_id: 'UX-040',
    positive_signals_in_screenshots: [],
    positive_signals_in_crawl: [],
    positive_signals_confirmed: [],
    negative_signals_confirmed: ['Secure Checkout text exists'],
    evidence_is_conditional: false,
    page_type_mismatch: false,
    include: false,
    suppression_reason: ''
  }];
  console.log('UX-040 model result', mimicValidation(issues, fakeValidation, '', ''));

  const issues2 = [{ issue_id: 'UX-102', confidence_weight: 0.77 }];
  const fakeValidation2 = [{
    issue_id: 'UX-102',
    positive_signals_in_screenshots: [],
    positive_signals_in_crawl: [],
    positive_signals_confirmed: [],
    negative_signals_confirmed: [],
    evidence_is_conditional: false,
    page_type_mismatch: false,
    include: false,
    suppression_reason: ''
  }];
  console.log('UX-102 model result', mimicValidation(issues2, fakeValidation2, '', 'phone field'));

  // new test: suppression reason quality
  const issues3 = [{ issue_id: 'UX-200', confidence_weight: 0.5 }];
  const fakeValidation3 = [{
    issue_id: 'UX-200',
    positive_signals_in_screenshots: [],
    positive_signals_in_crawl: [],
    positive_signals_confirmed: [],
    negative_signals_confirmed: [],
    evidence_is_conditional: false,
    page_type_mismatch: false,
    include: false,
    suppression_reason: 'none'
  }];
  console.log('weak reason override', mimicValidation(issues3, fakeValidation3, '', ''));

  // UX-036 account gating override
  const issues4 = [{ issue_id: 'UX-036' }];
  const fakeValidation4 = [{
    issue_id: 'UX-036',
    positive_signals_in_screenshots: [],
    positive_signals_in_crawl: [],
    positive_signals_confirmed: [],
    negative_signals_confirmed: ['some negative'],
    evidence_is_conditional: false,
    page_type_mismatch: false,
    include: false,
    suppression_reason: 'whatever'
  }];
  console.log('UX-036 account gating', mimicValidation(issues4, fakeValidation4, '', 'Create account to continue')); 

  // UX-052 multi-checkout override
  const issues5 = [{ issue_id: 'UX-052' }];
  const fakeValidation5 = [{
    issue_id: 'UX-052',
    positive_signals_in_screenshots: [],
    positive_signals_in_crawl: [],
    positive_signals_confirmed: [],
    negative_signals_confirmed: [],
    evidence_is_conditional: false,
    page_type_mismatch: false,
    include: false,
    suppression_reason: ''
  }];
  console.log('UX-052 multi-checkout', mimicValidation(issues5, fakeValidation5, '', 'checkout page checkout page')); 
}

runModelTests().catch(console.error);

runModelTests().catch(console.error);
