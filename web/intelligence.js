// Shared validation for automatic roles and source-backed interview reports.
const nonempty = (v, n) => typeof v === 'string' && !!v.trim() && v.length <= n;
export function roleContext(s) {
  return { segments: s.segments.slice(-32).map(x => ({ id: x.id, text: x.text, speakerKey: x.speakerKey || null, role: x.role, roleSource: x.roleSource || (x.role !== 'unknown' ? 'manual' : null) })), bindings: s.speakerBindings || {} };
}
export function validateRoles(raw, ctx) {
  if (!Array.isArray(raw?.assignments) || raw.assignments.length > 32) throw new Error('自动角色识别格式无效。');
  const seen = new Set();
  return { assignments: raw.assignments.map(a => {
    const seg = ctx.segments.find(x => x.id === a.segmentId);
    if (!seg || !['host','guest'].includes(a.role) || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1 || !nonempty(a.quote,1200) || !seg.text.includes(a.quote) || seen.has(seg.id)) throw new Error('自动角色识别依据无效。');
    seen.add(seg.id);
    return {segmentId:seg.id, speakerKey:seg.speakerKey || null, role:a.role, confidence:a.confidence, quote:a.quote};
  }) };
}
export function applyRoles(s, raw, ctx) {
  const {assignments} = validateRoles(raw,ctx), eligible=assignments.filter(a=>a.confidence>=0.9);
  const groups = new Map();
  for(const a of eligible) {const key=a.speakerKey || a.segmentId; if(!groups.has(key))groups.set(key,new Set());groups.get(key).add(a.role);}
  const changed=[];s.speakerBindings ||= {};s.speakerBindingSources ||= {};
  for(const a of eligible) {
    if(groups.get(a.speakerKey || a.segmentId).size!==1)continue;
    if(a.speakerKey && s.speakerBindings[a.speakerKey])continue;
    const targets=a.speakerKey?s.segments.filter(x=>x.speakerKey===a.speakerKey):s.segments.filter(x=>x.id===a.segmentId);
    for(const seg of targets) {
      if(seg.role!=='unknown' || seg.roleSource==='manual')continue;
      seg.role=a.role;seg.roleSource='auto';seg.roleConfidence=a.confidence;seg.roleEvidence={segmentId:a.segmentId,quote:a.quote};seg.revision++;seg.analyzedRevision=null;changed.push(seg.id);
    }
    if(a.speakerKey && targets.some(x=>x.roleSource==='auto')) {s.speakerBindings[a.speakerKey]=a.role;s.speakerBindingSources[a.speakerKey]='auto';}
  }
  if(changed.length)s.revision++;
  return changed;
}
export function summaryContext(topic,s) {
  return {topic:topic.title,goal:s.goal,items:s.items.map(i=>({id:i.id,label:i.label,question:i.question})),segments:s.segments.map(x=>({id:x.id,text:x.text,role:x.role,roleSource:x.roleSource||null})),questions:s.questions.slice(-500).map(q=>({id:q.id,itemId:q.itemId,text:q.text,status:q.status}))};
}
export function validateSummary(raw,ctx) {
  const cite = p => {
    if(!nonempty(p?.text,1600)||!Array.isArray(p.sources)||!p.sources.length||p.sources.length>8)throw new Error('归纳要点缺少出处。');
    return {text:p.text,sources:p.sources.map(ref=>{const s=ctx.segments.find(s=>s.id===ref.segmentId);if(!s||s.role!=='guest'||!nonempty(ref.quote,1200)||!s.text.includes(ref.quote))throw new Error('归纳引文或嘉宾归属无效。');return {segmentId:s.id,quote:ref.quote};})};
  };
  if(!Array.isArray(raw?.overview)||raw.overview.length>5||!Array.isArray(raw.chapters)||raw.chapters.length!==ctx.items.length||!Array.isArray(raw.followUps)||raw.followUps.length>12)throw new Error('访谈归纳结构无效。');
  const used=new Set();
  const chapters=raw.chapters.map(c=>{if(!ctx.items.some(i=>i.id===c.itemId)||used.has(c.itemId)||!Array.isArray(c.points)||c.points.length>8)throw new Error('归纳主线无效。');used.add(c.itemId);return {itemId:c.itemId,points:c.points.map(cite)};});
  const followUps=raw.followUps.map(q=>{if(!ctx.items.some(i=>i.id===q.itemId)||!nonempty(q.text,300))throw new Error('待补问内容无效。');return {itemId:q.itemId,text:q.text};});
  return {overview:raw.overview.map(cite),chapters,followUps};
}
