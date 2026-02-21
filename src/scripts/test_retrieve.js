const { loadIssueLibrary, simpleRetrieveIssues } = require('../lib/ux');
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

})();
