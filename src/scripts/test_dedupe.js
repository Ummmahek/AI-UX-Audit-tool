function dedupeReportText(text){
  const parts = text.split(/\n{2,}/g);
  const bestById = {};
  const evidenceTerms=["evidence","screenshot","crawl"];
  parts.forEach((p,i)=>{
    const ids=p.match(/UX-\d{3}/g);
    if(!ids) return;
    ids.forEach(id=>{
      let score = p.split(/\s+/).length * 0.01;
      const lower=p.toLowerCase();
      evidenceTerms.forEach(term=>{ score += (lower.split(term).length-1)*0.5; });
      if(!bestById[id]||score>bestById[id].score){
        bestById[id]={part:p,score,index:i};
      }
    });
  });
  const chosen=new Set();
  const final=[];
  parts.forEach((p,i)=>{
    const ids=p.match(/UX-\d{3}/g);
    if(!ids){ final.push(p); return; }
    const id=ids[0];
    if(chosen.has(id)) return;
    if(bestById[id] && bestById[id].index===i){ final.push(p); chosen.add(id); }
  });
  return final.join("\n\n");
}

const sample="Discover:\n- UX-052: weak issue\n\nDecide:\n- UX-052: strong issue with screenshot evidence\n\nBook:\n- UX-052: another weak mention\n";
console.log('deduped text:\n'+dedupeReportText(sample));
