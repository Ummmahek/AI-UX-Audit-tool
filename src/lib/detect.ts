import type { DomChecks } from './crawl';

export type DetectedIssue = {
  issue_id: string;
  issue_title: string;
  source: 'deterministic';
  confidence: number; // always 1.0
  evidence: string;
  page_url: string;
  page_label: string; // e.g. "checkout", "homepage", "product"
};

type RuleDefinition = {
  issue_id: string;
  issue_title: string;
  // screenshotText provided for rules that need OCR context
  condition: (flags: DomChecks, pageLabel: string, screenshotText?: string) => boolean;
  evidence: (flags: DomChecks) => string;
};

const RULES: RuleDefinition[] = [
  // --- Accessibility ---
  {
    issue_id: 'DET-001',
    issue_title: 'Images missing alt text',
    condition: (f) => f.images_missing_alt > 0,
    evidence: (f) => `Found ${f.images_missing_alt} image(s) with missing or empty alt attribute`,
  },
  {
    issue_id: 'DET-002',
    issue_title: 'Form inputs missing labels',
    condition: (f) => f.has_placeholder_only_labels,
    evidence: () => 'Found input(s) with placeholder but no associated label or aria-label',
  },
  {
    issue_id: 'DET-003',
    issue_title: 'Buttons with no accessible text',
    condition: (f) => f.buttons_missing_text > 0,
    evidence: (f) => `Found ${f.buttons_missing_text} button(s) with no text, aria-label, or title`,
  },
  // --- Heading structure ---
  {
    issue_id: 'DET-004',
    issue_title: 'Page missing H1 heading',
    condition: (f, _page, screenshotText) =>
      !f.has_h1 &&
      !screenshotText?.match(/^[A-Z][a-zA-Z\s]{3,60}$/m),
    evidence: () => 'No H1 element found on the page',
  },
  {
    issue_id: 'DET-005',
    issue_title: 'Multiple H1 headings on page',
    condition: (f, _page, screenshotText) =>
      f.multiple_h1 &&
      !screenshotText?.match(/^[A-Z][a-zA-Z\s]{3,60}$/m),
    evidence: () => 'More than one H1 element found — only one H1 is recommended per page',
  },
  {
    issue_id: 'DET-006',
    issue_title: 'Broken heading hierarchy (H3 before H2)',
    condition: (f) => f.skipped_heading_level,
    evidence: () => 'H3 element appears with no preceding H2 — heading levels are skipped',
  },
  // --- Meta & SEO ---
  {
    issue_id: 'DET-007',
    issue_title: 'Missing or too-short meta description',
    condition: (f) => f.meta_description_length < 50,
    evidence: (f) => f.meta_description_length === 0
      ? 'Meta description is missing entirely'
      : `Meta description is only ${f.meta_description_length} characters (minimum recommended: 50)`,
  },
  {
    issue_id: 'DET-008',
    issue_title: 'Missing or too-short page title',
    condition: (f) => f.title_length < 10,
    evidence: (f) => f.title_length === 0
      ? 'Page title is missing'
      : `Page title is only ${f.title_length} characters`,
  },
  // --- Trust & Security (checkout-specific) ---
  {
    issue_id: 'DET-009',
    issue_title: 'No trust badges or security signals on checkout',
    condition: (f, page) =>
      (page === 'checkout' || page === 'cart') && !f.has_trust_badges && !f.has_ssl_text,
    evidence: () => 'No trust badge elements or SSL/security text found on checkout page DOM',
  },
  // --- Checkout flow ---
  {
    issue_id: 'DET-010',
    issue_title: 'No checkout progress indicator',
    condition: (f, page) => page === 'checkout' && !f.has_progress_indicator,
    evidence: () => 'No progress indicator, stepper, or step counter element found on checkout page',
  },
  {
    issue_id: 'DET-011',
    issue_title: 'No guest checkout option',
    condition: (f, page) => page === 'checkout' && !f.has_guest_checkout,
    evidence: () => 'No guest checkout / continue without account text found on checkout page',
  },
  // new high-value absence rules
  {
    issue_id: 'DET-015',
    issue_title: 'No guest checkout option',
    condition: (f, page) =>
      page === 'checkout' && !f.has_guest_checkout,
    evidence: () =>
      'No guest checkout / continue without account option found in checkout page DOM',
  },
  {
    issue_id: 'DET-016',
    issue_title: 'Payment methods hidden until address entered',
    condition: (f, page) =>
      page === 'checkout' && f.form_submit_count > 0 && !f.has_price_display,
    evidence: () =>
      'Payment section present but gated — no payment options visible before address is completed',
  },
  {
    issue_id: 'DET-017',
    issue_title: 'Disabled CTA with no explanation',
    condition: (f) => f.has_disabled_cta_no_hint,
    evidence: () =>
      'A submit/continue button is visually disabled with no inline error or helper text explaining why',
  },
  // --- Navigation ---
  {
    issue_id: 'DET-012',
    issue_title: 'No breadcrumb navigation',
    condition: (f, page) =>
      (page === 'product' || page === 'category') && !f.has_breadcrumbs,
    evidence: () => 'No breadcrumb element found on product/category page',
  },
  {
    issue_id: 'DET-013',
    issue_title: 'No search bar present',
    condition: (f, page) => page === 'homepage' && !f.has_search_bar,
    evidence: () => 'No search input found on homepage',
  },
  // --- CTAs ---
  {
    issue_id: 'DET-014',
    issue_title: 'Too many competing primary CTAs',
    condition: (f) => f.has_multiple_primary_ctas,
    evidence: (f) => `Found ${f.primary_cta_count} primary CTA buttons — more than 2 creates visual competition`,
  },
  // --- DOM-checkable UX library issues added per vision-scope prompt ---
  {
    issue_id: 'UX-052',
    issue_title: 'No progress indicator in multi-step flow',
    condition: (f, page) => page === 'checkout' && !f.has_progress_indicator,
    evidence: () =>
      'No step counter, progress bar, or stepper element found on checkout page',
  },
  {
    issue_id: 'UX-040',
    issue_title: 'Security reassurance missing near payment',
    condition: (f, page) =>
      (page === 'checkout' || page === 'cart') &&
      !f.has_trust_badges &&
      !f.has_ssl_text,
    evidence: () =>
      'No trust badge, SSL indicator, or security text found near checkout/payment area',
  },
  {
    issue_id: 'UX-036',
    issue_title: 'No guest checkout option',
    condition: (f, page) => page === 'checkout' && !f.has_guest_checkout,
    evidence: () =>
      'No guest checkout or continue-without-account option found in checkout DOM',
  },
  {
    issue_id: 'UX-038',
    issue_title: 'No inline form validation',
    condition: (f, page) =>
      (page === 'checkout' || page === 'product') &&
      !f.has_inline_error_styles &&
      f.form_submit_count > 0,
    evidence: () =>
      'Form present but no inline error/validation elements found in DOM',
  },
];

/**
 * Runs all deterministic DOM rules against a set of crawled pages.
 * Returns a flat array of confirmed issues — one entry per rule hit per page.
 * No LLM is called. No false positives from inference.
 */
export function runDeterministicDetection(
  pages: Array<{ url: string; label: string; domChecks: DomChecks }>,
  screenshotOcrText: string
): DetectedIssue[] {
  const results: DetectedIssue[] = [];

  for (const page of pages) {
    for (const rule of RULES) {
      if (rule.condition(page.domChecks, page.label, screenshotOcrText)) {
        results.push({
          issue_id: rule.issue_id,
          issue_title: rule.issue_title,
          source: 'deterministic',
          confidence: 1.0,
          evidence: rule.evidence(page.domChecks),
          page_url: page.url,
          page_label: page.label,
        });
      }
    }
  }

  return results;
}
