// Versioned host-interview domain. Legacy checklist sessions stay on protocol v1.
import { uid, now, clone } from './core.js';
export const CHAPTER_STATUS = { untouched: '未展开', active: '正在展开', content: '已有内容', supplement: '待补充', closed: '主持人确认结束' };
export const QUESTION_STATUS = { candidate: '候选', displayed: '当前展示', asked: '已问待回应', answered: '已回应', deferred: '稍后', skipped: '跳过', superseded: '被新信息替代' };
export const QUESTION_TYPE = { deepen: '顺着回答深挖', supplement: '补充当前主线', transition: '过渡到下一主线' };
export const isInterview = s => s.analysisVersion === 2;
export const availableQuestions = s => s.questions.filter(q => ['candidate', 'displayed'].includes(q.status));
const text = (v, max = 1600) => typeof v === 'string' && !!v.trim() && v.length <= max;
export const normalizedQuestion = v => String(v).replace(/[\s，。？！、,.?!“”"'：:]/g, '').toLowerCase();
export function chapterStatus(s, id) {
  if (s.chapterStates?.[id] === 'closed') return 'closed';
  if (s.questions.some(q => q.itemId === id && q.status === 'asked')) return 'supplement';
  if (s.currentChapterId === id && !s.endedAt) return 'active';
  return s.claims.some(c => c.itemId === id) ? 'content' : 'untouched';
}
export function selectQuestion(s, id) {
  if (s.paused || s.endedAt) throw new Error('暂停或结束后不能切换现场提示。');
  const q = availableQuestions(s).find(x => x.id === id);
  if (!q) throw new Error('候选已更新，请重新选择。');
  for (const old of availableQuestions(s)) old.status = old.id === id ? 'displayed' : 'candidate';
  s.displayedQuestionId = id; s.newCandidates = false; s.revision++;
}
export function questionFeedback(s, id, status) {
  if (s.paused || s.endedAt || !['asked', 'skipped', 'deferred'].includes(status)) return;
  const q = availableQuestions(s).find(x => x.id === id);
  if (!q) return;
  q.status = status; q.feedbackAt = now(); if (status === 'asked') q.manuallyAsked = true; q.askedAfter = status === 'asked' ? s.segments.length : undefined;
  if (s.displayedQuestionId === id) s.displayedQuestionId = null;
  const next = availableQuestions(s)[0];
  if (next && !s.displayedQuestionId) { next.status = 'displayed'; s.displayedQuestionId = next.id; }
  s.revision++;
}
export function addHostQuestion(s, value, itemId = s.currentChapterId, segmentId = null, quote = null) {
  if (!text(value, 100) || !s.items.some(i => i.id === itemId) || s.endedAt || s.paused) throw new Error('请填写 1–100 字的问题并选择有效主线。');
  const same = s.questions.find(q => normalizedQuestion(q.text) === normalizedQuestion(value) && q.status === 'asked');
  if (same) return same;
  const q = { id: uid(), itemId, text: value.trim(), status: 'asked', type: 'supplement', basisType: 'outline', gap: '主持人实际提出，等待嘉宾回应', source: segmentId ? 'model' : 'manual', segmentId, quote, createdAt: now(), askedAfter: s.segments.length, askedSegmentId: segmentId, autoAsked: !!segmentId, manuallyAsked: !segmentId };
  s.questions.push(q); s.revision++; return q;
}
export function setChapter(s, id, close = false) {
  if (s.endedAt || s.paused || !s.items.some(i => i.id === id)) throw new Error('当前不能调整主线。');
  s.chapterStates ||= {};
  if (close) s.chapterStates[id] = s.chapterStates[id] === 'closed' ? 'untouched' : 'closed';
  else s.currentChapterId = id;
  // A manual chapter change is an explicit change of attention.
  for (const q of availableQuestions(s)) q.status = 'superseded';
  s.displayedQuestionId = null; s.newCandidates = false; s.revision++;
}
export function invalidateInterview(s) {
  s.events.push({ type: 'interview-invalidated', at: now(), questions: clone(s.questions), summaries: clone(s.chapterSummaries || {}) });
  s.questions = s.questions.filter(q => !(q.autoAsked && !q.manuallyAsked) && ['asked', 'answered', 'skipped', 'deferred'].includes(q.status));
  for (const q of s.questions) { if (q.status === 'answered') q.status = 'asked'; delete q.response; }
  delete s.interviewSummary; s.summaryStatus=''; s.summaryError=''; s.manualSummaryChapters={};
  s.chapterSummaries = {}; s.displayedQuestionId = null; s.newCandidates = false;
}
export function bindSpeaker(s, key, role) {
  if (!['host', 'guest', 'unknown'].includes(role) || s.endedAt || s.paused) throw new Error('说话人绑定无效。');
  if (!s.segments.some(seg => seg.speakerKey === key)) throw new Error('说话人编号不存在。');
  s.speakerBindings ||= {}; s.speakerBindings[key] = role; s.speakerBindingSources ||= {}; s.speakerBindingSources[key]='manual';
  for (const seg of s.segments) if (seg.speakerKey === key) {
    seg.edits.push({ text: seg.text, role: seg.role, at: now() }); seg.role = role; seg.roleSource='manual'; seg.revision++;
  }
  invalidateInterview(s); s.claims = []; s.actions = [];
  for (const seg of s.segments) seg.analyzedRevision = null;
  s.revision++;
}
export function interviewContext(topic, s, segment, batch = [segment]) {
  // Reserve source-backed memory per chapter before filling the recent window.
  // Every claim sent still has its verbatim source in the context.
  const memory = s.items.flatMap(i => s.claims.filter(c => c.itemId === i.id).filter((_, index, list) => index < 2 || index >= list.length - 4));
  const wanted = new Set([...batch.map(x=>x.id), ...memory.map(c => c.segmentId)]);
  const selected = [], included = new Set(); let budget = 40000;
  const take = seg => { if (!seg || included.has(seg.id) || seg.text.length > budget) return; budget -= seg.text.length; selected.push({ id: seg.id, text: seg.text, role: seg.role, sessionId: s.id, speakerKey: seg.speakerKey || null, index: s.segments.indexOf(seg)+1 }); included.add(seg.id); };
  for (const seg of batch) take(seg);
  for (const seg of s.segments) if (wanted.has(seg.id)) take(seg);
  for (const seg of [...s.segments].reverse().slice(0, 80)) take(seg);
  return { analysisVersion: 2, batchIds: batch.map(x=>x.id), revision: s.revision, segmentRevision: segment.revision, sessionId: s.id, segmentId: segment.id, topic: topic.title, goal: s.goal, role: segment.role, guestBackground: s.guestBackground || '', backgroundSource: s.backgroundSource || '', boundaries: s.boundaries || '', currentChapterId: s.currentChapterId, items: s.items, chapterStates: s.chapterStates || {}, plannedMinutes:s.plannedMinutes||0, elapsedMinutes:Math.max(0,(Date.now()-Date.parse(s.startedAt))/60000)||0, segments: selected, claims: memory.filter(c => included.has(c.segmentId)), questions: s.questions.slice(-100).map(q => ({ id: q.id, itemId: q.itemId, text: q.text, status: q.status, informationGoal: q.informationGoal, segmentId: q.segmentId, askedSegmentId: q.askedSegmentId, askedAfter: q.askedAfter, response: q.response })), segmentIndex: s.segments.indexOf(segment) + 1 };
}
export function validateInterview(raw, ctx) {
  if (!raw || raw.analysisVersion !== 2 || !Array.isArray(raw.candidates) || raw.candidates.length > 3 || !Array.isArray(raw.claims) || raw.claims.length > 30 || !Array.isArray(raw.responses) || raw.responses.length > 30 || !Array.isArray(raw.hostQuestions) || raw.hostQuestions.length > 5) throw new Error('主持人分析 v2 结构无效。');
  const items = new Map(ctx.items.map(i => [i.id, i])), segments = new Map(ctx.segments.map(s => [s.id, s])), current = segments.get(ctx.segmentId);
  const cite = (v, role, currentOnly = false) => {
    const seg = segments.get(v.segmentId);
    if (!seg || seg.role !== role || (currentOnly && !(ctx.batchIds || [ctx.segmentId]).includes(seg.id)) || !text(v.quote) || !seg.text.includes(v.quote)) throw new Error('原话依据或说话人归属无效。');
    return { segmentId: seg.id, quote: v.quote };
  };
  const chapter = v => { if (!items.has(v.itemId)) throw new Error('主线归属无效。'); return v.itemId; };
  const claims = raw.claims.map(c => {
    if (!text(c.text) || !['current', 'future', 'hypothesis', 'denial', 'unknown'].includes(c.kind) || !['unknown', 'vague', 'stated', 'conflict'].includes(c.status)) throw new Error('主线信息字段无效。');
    return { ...cite(c, 'guest', true), itemId: chapter(c), text: c.text, kind: c.kind, status: ['future', 'hypothesis', 'unknown'].includes(c.kind) && c.status === 'stated' ? 'vague' : c.status, evidence: '嘉宾口头陈述，未经事实核验' };
  });
  const seen = new Set(), goals = new Set();
  const candidates = raw.candidates.map(q => {
    if (!text(q.text, 100) || !text(q.gap, 500) || !text(q.informationGoal, 100) || !Object.prototype.hasOwnProperty.call(QUESTION_TYPE, q.type) || !['transcript', 'outline'].includes(q.basisType)) throw new Error('候选问题字段无效。');
    const key = normalizedQuestion(q.text), goal = normalizedQuestion(q.informationGoal);
    if (seen.has(key) || goals.has(goal)) throw new Error('候选问题的信息目标重复。');
    seen.add(key); goals.add(goal);
    const evidence = q.basisType === 'transcript' ? cite(q, 'guest') : { segmentId: null, quote: null };
    if (q.type === 'deepen' && q.basisType !== 'transcript') throw new Error('深挖题必须有嘉宾原话。');
    if ((ctx.shortHints || q.hint != null) && !text(q.hint, 28)) throw new Error('眼镜提示应为 1–28 字。');
    return { itemId: chapter(q), text: q.text, hint: q.hint || null, gap: q.gap, informationGoal: q.informationGoal, type: q.type, basisType: q.basisType, ...evidence };
  }).filter(q => !ctx.questions.some(old => (normalizedQuestion(old.text) === normalizedQuestion(q.text) || (old.informationGoal && normalizedQuestion(old.informationGoal) === normalizedQuestion(q.informationGoal))) && ['asked', 'answered', 'skipped', 'deferred'].includes(old.status)));
  const responses = raw.responses.map(r => {
    const freshHost=raw.hostQuestions.find(h=>`host:${h.segmentId}`===r.questionId && !h.questionId);
    const q = ctx.questions.find(q => q.id === r.questionId && ['asked', 'candidate', 'displayed', 'deferred'].includes(q.status)) || (freshHost ? {status:'asked',askedAfter:segments.get(freshHost.segmentId)?.index,askedSegmentId:freshHost.segmentId} : null);
    const matchedHost=raw.hostQuestions.find(h=>h.questionId===r.questionId);
    if(matchedHost && (segments.get(r.segmentId)?.index || ctx.segmentIndex)<=(segments.get(matchedHost.segmentId)?.index || ctx.segmentIndex)) throw new Error('回应必须晚于本批次提问。');
    if (!q || q.status === 'asked' && ((segments.get(r.segmentId)?.index || ctx.segmentIndex) <= (q.askedAfter || 0) || q.askedSegmentId === r.segmentId)) throw new Error('回应关联问题或轮次无效。');
    return { questionId: r.questionId, ...cite(r, 'guest', true) };
  });
  const hostQuestions = raw.hostQuestions.map(q => {
    if (!text(q.text, 100)) throw new Error('主持人问题无效。');
    const evidence = cite(q, 'host', true);
    if (!evidence.quote.includes(q.text)) throw new Error('自动已问问题必须逐字来自主持人原话。');
    if (q.questionId && !ctx.questions.some(old => old.id === q.questionId && ['candidate', 'displayed'].includes(old.status))) throw new Error('已问候选关联无效。');
    return { text: q.text, itemId: chapter(q), questionId: q.questionId || null, ...evidence };
  });
  if (!current) throw new Error('当前片段不存在。');
  const reviews = (raw.reviews || []).map(r => {
    if (!ctx.questions.some(q=>q.id===r.questionId && ['candidate','displayed'].includes(q.status)) || !['keep','superseded'].includes(r.status) || !text(r.reason,300)) throw new Error('提示有效性核对无效。');
    return {questionId:r.questionId,status:r.status,reason:r.reason};
  });
  if (reviews.length>3 || new Set(reviews.map(r=>r.questionId)).size!==reviews.length) throw new Error('提示核对重复或过多。');
  const answered = new Set(responses.map(r=>r.questionId));
  const filtered = candidates.filter(q=>!ctx.questions.some(old=>answered.has(old.id) && (normalizedQuestion(old.text)===normalizedQuestion(q.text) || old.informationGoal && normalizedQuestion(old.informationGoal)===normalizedQuestion(q.informationGoal))));
  return { analysisVersion: 2, claims, candidates: filtered, responses, hostQuestions, reviews, actions: [] };
}
export function applyInterview(s, segment, raw, ctx, source) {
  if (s.paused || s.endedAt || s.revision !== ctx.revision || s.id !== ctx.sessionId || segment.revision !== ctx.segmentRevision) throw new Error('访谈已变化，旧分析已丢弃；请重新分析。');
  const result = validateInterview(raw, ctx);
  s.events.push({ type: 'analysis-v2', at: now(), segmentId: segment.id, source });
  s.claims = s.claims.filter(c => !(ctx.batchIds || [segment.id]).includes(c.segmentId));
  s.claims.push(...result.claims.map(c => ({ ...c, id: uid(), role: 'guest', source, createdAt: now() })));
  const newQuestions=new Map();
  for (const h of result.hostQuestions) {
    const q = s.questions.find(q => q.id === h.questionId);
    if (q) { q.status = 'asked'; q.askedAfter = ctx.segments.find(x=>x.id===h.segmentId)?.index || ctx.segmentIndex; q.askedSegmentId = h.segmentId; q.feedbackAt = now(); q.autoAsked = true; }
    else { const q = addHostQuestion(s, h.text, h.itemId, h.segmentId, h.quote); q.askedAfter = ctx.segments.find(x=>x.id===h.segmentId)?.index || ctx.segmentIndex; newQuestions.set(`host:${h.segmentId}`,q); }
  }
  for (const r of result.responses) { const q = s.questions.find(q => q.id === r.questionId) || newQuestions.get(r.questionId); q.status = 'answered'; q.response = r; }
  for (const r of result.reviews) { const q=s.questions.find(q=>q.id===r.questionId); if (q && ['candidate','displayed'].includes(q.status)) { if(r.status==='superseded')q.status='superseded'; q.reviewReason=r.reason; q.reviewedAt=now(); } }
  for(const q of availableQuestions(s)) if(Date.now()-Date.parse(q.reviewedAt || q.createdAt)>60000) { q.status='superseded';q.reviewReason='提示超过60秒未重新确认，已收起。'; }
  const retained = availableQuestions(s).find(q => q.id === s.displayedQuestionId);
  for (const q of availableQuestions(s)) if (q !== retained) q.status = 'superseded';
  const fresh = result.candidates.filter(q => !retained || normalizedQuestion(q.text) !== normalizedQuestion(retained.text) && normalizedQuestion(q.informationGoal) !== normalizedQuestion(retained.informationGoal)).slice(0, retained ? 2 : 3);
  for (const q of fresh) s.questions.push({ ...q, id: uid(), status: 'candidate', source, createdAt: now() });
  const selected = retained || availableQuestions(s)[0];
  s.displayedQuestionId = selected?.id || null;
  if (selected) selected.status = 'displayed';
  s.newCandidates = !!retained && !!fresh.length;
  for (const seg of s.segments) if ((ctx.batchIds || [segment.id]).includes(seg.id)) seg.analyzedRevision=seg.revision; s.revision++;
  return result;
}
export function interviewMarkdown(topic, s) {
  const lines = ['### 按主线回看', '', `嘉宾背景：${s.guestBackground || '未填写'}`, `资料来源：${s.backgroundSource || '未注明，需核对'}`, `重点与边界：${s.boundaries || '未填写'}`, ''];
  if(s.interviewSummary) {
    lines.push('### 整场访谈归纳（AI 草案）','');
    for(const point of s.interviewSummary.overview)lines.push(`- ${point.text}`,...point.sources.map(ref=>`  > ${ref.quote}（${ref.segmentId}）`));
    lines.push('','### 待补问与核对','');
    for(const q of s.interviewSummary.followUps)lines.push(`- ${s.items.find(i=>i.id===q.itemId)?.label || ''}：${q.text}`);
    lines.push('');
  }
  for (const item of s.items) {
    lines.push(`#### ${item.label} · ${CHAPTER_STATUS[chapterStatus(s, item.id)]}`, '', `内容目标：${item.question}`, `预设问题：${item.preparedQuestions || '未填写'}`, '', `主持人摘要（可编辑，需核对）：${s.chapterSummaries?.[item.id] || '未整理'}`, '');
    for(const point of s.interviewSummary?.chapters.find(c=>c.itemId===item.id)?.points||[])lines.push(`- AI 归纳原稿：${point.text}`,...point.sources.map(ref=>`  > ${ref.quote}（${ref.segmentId}）`));
    for (const c of s.claims.filter(c => c.itemId === item.id)) lines.push(`- 嘉宾自述：${c.text}`, `  > ${c.quote}`, `  来源片段：${c.segmentId}`);
    for (const q of s.questions.filter(q => q.itemId === item.id)) lines.push(`- [${QUESTION_STATUS[q.status] || q.status}] ${q.text}`, `  依据：${q.basisType === 'outline' ? '主持人提纲 / 实际提问' : `${q.quote}（${q.segmentId}）`}`, ...(q.response ? [`  回应：${q.response.quote}（${q.response.segmentId}）`] : []));
    lines.push('');
  }
  return lines.join('\n');
}
