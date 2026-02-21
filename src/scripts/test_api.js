(async()=>{
  const { POST } = require('../app/api/generate/route');
  const body = JSON.stringify({ url:'https://example.com', goal:'buy', useCompany:true, topK:20 });
  const req = new Request('http://localhost/api/generate', { method:'POST', headers:{'content-type':'application/json'}, body });
  const res = await POST(req);
  const json = await res.json();
  console.log('API returned ids', json.retrievedIssues.map(i=>i.issue_id));
  console.log('suppressed', json.suppressedIssues);
  console.log('report snippet:\n', json.report.split('\n').slice(0,20).join('\n'));
})();
