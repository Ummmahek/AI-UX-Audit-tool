const { loadIssueLibrary, simpleRetrieveIssues, retrieveRelevantIssues, inferSiteType, getTerminology } = require('../lib/ux');
(async () => {
  const lib = await loadIssueLibrary();
  const ux052 = lib.find(i => i.issue_id === 'UX-052');
  if (ux052) { lib.push({ ...ux052 }); lib.push({ ...ux052 }); }
  console.log('--- base retrieval (no crawl, no screenshots) ---');
  const res1 = simpleRetrieveIssues(lib, 'https://example.com', 'payment', 20, '', '', false);
  const ids1 = res1.map(i => i.issue_id);
  console.log('retrieved ids', ids1);
  const count1 = ids1.reduce((acc, id) => { acc[id] = (acc[id] || 0) + 1; return acc; }, {});
  console.log('counts', count1);

  // test screenshot-text based matching: pretend images contain PDP/Cart content
  const screenshotText = 'save button greyed out no inline validation return policy missing shipping cost shown eligible items add to cart no toast';
  console.log('\n--- retrieval with screenshotText ---');
  const res2 = simpleRetrieveIssues(lib, 'https://example.com', 'payment', 20, '', screenshotText, true);
  const ids2 = res2.map(i => i.issue_id);
  console.log('retrieved ids', ids2);
  const missing = ['UX-038','UX-005','UX-035','UX-075','UX-051'];
  for (const id of missing) {
    console.log(`${id} present?`, ids2.includes(id));
  }

  // ------------------------------------------------------------------
  // new tests for site-type detection / non-ecommerce filtering
  console.log('\n--- non-ecommerce (real estate) retrieval ---');
  const nonEcomText = 'property listing map filters price';
  const res3 = simpleRetrieveIssues(lib, 'https://example.com', 'find house', 20, nonEcomText, '', false);
  const ids3 = res3.map(i => i.issue_id);
  console.log('retrieved ids (non-ecom)', ids3);
  // ensure no cart/checkout-only issues slip through
  const cartOnly = ['UX-007','UX-034','UX-097','UX-008','UX-009','UX-035','UX-036'];
  for (const id of cartOnly) {
    console.log(`${id} filtered out?`, !ids3.includes(id));
  }

  console.log('\n--- retrieveRelevantIssues wrapper ---');
  const wrapper = await retrieveRelevantIssues('https://example.com', 'find house', 10, nonEcomText, '', false);
  console.log('wrapper metadata', { siteType: wrapper.siteType, terminology: wrapper.terminology, applicable: wrapper.applicableCount, total: wrapper.totalCount });

  // quick siteTypeDetection check
  const det = detectSiteType(nonEcomText, 'https://example.com');
  console.log('detectSiteType result', det);

  // sanity-check new crawler helper (won't actually fetch due to offline environment)
  try {
    const { crawlWebsite } = require('../lib/crawlPlaywright');
    console.log('\n--- crawlWebsite smoke test ---');
    // not calling for real, just verify import works
    console.log('crawlWebsite function available:', typeof crawlWebsite);
  } catch (e) {
    console.error('crawlWebsite import failed', e);
  }

})();
