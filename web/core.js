import { interviewContext, validateInterview, applyInterview, invalidateInterview, interviewMarkdown } from './interview.js';
export const STATUS = { unknown: '未提及', vague: '仍含糊', stated: '具体陈述', conflict: '待核对差异' };
export const KIND = { current: '当前做法', future: '未来期望', hypothesis: '假设', denial: '明确否定', unknown: '不知道' };
import { last, hasOwn } from './platform.js';
export const uid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export const now = () => new Date().toISOString();
// 访谈状态是 JSON 数据，旧 WebView 不需要 structuredClone 也能保存。
export const clone = value => JSON.parse(JSON.stringify(value));

export const TEMPLATES = {
  host: { label: '主持人访谈', title: '一个普通人第一次做独立项目的经历', role: 'guest',
    goal: '让听众理解为什么开始、关键决定、踩过的坑和现在的看法。',
    items: [['origin', '起因', '是什么让你决定开始自己的项目？'], ['choice', '关键选择', '过程里做过哪些关键决定，为什么？'], ['difficulty', '最大困难', '最难的一次经历是什么，你如何应对？'], ['reflection', '回看与建议', '现在回看有什么变化，会给后来者什么建议？']] },
  fde: {
    label: 'FDE 需求访谈', title: '售后工单 Agent', role: '客服主管',
    goal: '确认第一版工单分派流程，以及 AI 与人工处理的边界。',
    items: [
      ['flow', '真实流程', '一张工单从进来到处理完成，分别经过谁？'],
      ['rules', '规则与例外', '投诉件遇到例外或无人响应时怎么处理？'],
      ['data', '数据与知识', '判断工单时需要哪些资料，由谁维护？'],
      ['system', '系统依赖', '需要读取或修改哪些系统，接口由谁确认？'],
      ['boundary', '执行与人工边界', 'AI 是给分派建议，还是直接修改工单？'],
      ['acceptance', '验收条件', '哪些具体案例能说明第一版可以交付？']
    ]
  },
  research: {
    label: '用户研究', title: '一次未完成的报名', role: '体验用户',
    goal: '理解用户上次放弃提交报名表的具体经过和原因。',
    items: [
      ['step', '发生的步骤', '你上次是填到哪一步停下来的？'],
      ['intent', '当时的目标', '当时你想通过报名完成什么？'],
      ['attempt', '尝试的办法', '遇到困难以后，你试过哪些办法？'],
      ['reason', '放弃的原因', '最后让你决定放弃的具体原因是什么？']
    ]
  },
  custom: { label: '自定义访谈', title: '新的访谈主题', goal: '', role: '', items: [] }
};

export function newSession(template, topicId, priorItems) {
  const t = TEMPLATES[template] || TEMPLATES.custom;
  return {
    ...(template === 'host' ? { analysisVersion: 2, currentChapterId: priorItems?.[0]?.id || 'origin', chapterStates: {}, chapterSummaries: {}, speakerBindings: {}, displayedQuestionId: null, guestBackground: '', backgroundSource: '', boundaries: '' } : {}),
    id: uid(), topicId, goal: t.goal, role: t.role, startedAt: now(), endedAt: null,
    items: priorItems ? priorItems.map(i => ({ ...i })) : t.items.map(([id, label, question], index) => ({ id, label, question, priority: template === 'host' ? Math.min(3, t.items.length - index) : t.items.length - index })),
    confirmed: false, segments: [], pendingAsr: [], claims: [], questions: [], actions: [], revision: 0,
    paused: false, demoStep: 0, events: []
  };
}
export function newTopic(template = 'host') {
  const id = uid();
  return { id, title: TEMPLATES[template].title, template, createdAt: now(), sessions: [newSession(template, id)] };
}
// Preparation only: the script never preloads answers or generated conclusions.
export function newScriptTopic() {
  const topic=newTopic('host'), session=topic.sessions[0];
  topic.presetId='first-stranger';
  topic.title='第一个陌生用户之后：一个校园工具为什么差点做不下去';
  session.goal='聊清楚小周做校园报名工具的起因、一次具体挫折、取舍依据和当前状态，留下可以继续写成访谈文章的材料。';
  session.guestBackground='虚构演示人物：学生开发者小周，课余维护校园报名工具。主持人小林；嘉宾小周。';
  session.backgroundSource='问全《第一个陌生用户之后》两人演示剧本；人物、经历与数字均为虚构。';
  session.boundaries='不讨论学校、社团及真实用户身份；不将计划说成已上线。开场自然说明主持人与嘉宾角色。';
  session.items=[
    ['origin','起点','你为什么开始做这个校园报名工具？'],
    ['turning','转折','哪件具体的事改变了你对这个工具的判断？'],
    ['choice','选择','这件事之后，你做了什么取舍，为什么？'],
    ['next','后续','目前如何维护，接下来想确认什么？']
  ].map(([id,label,question])=>({id,label,question,priority:2,preparedQuestions:''}));
  session.currentChapterId=session.items[0].id;
  return topic;
}
export function newState(template = 'host') {
  const topic = newTopic(template);
  return { schema: 1, topics: [topic], topicId: topic.id, sessionId: topic.sessions[0].id, settings: { mode: 'model', captureMode: 'continuous', backend: '' } };
}
export function current(state) {
  const topic = state.topics.find(t => t.id === state.topicId);
  return { topic, session: topic?.sessions.find(s => s.id === state.sessionId) || (topic && last(topic.sessions)) };
}
export function addSegment(session, text, source = 'manual') {
  const trimmed = String(text).trim();
  if (!trimmed || trimmed.length > 12000) throw new Error('请输入 1–12000 字的对话片段。');
  if (session.endedAt) throw new Error('这次访谈已结束，请先续接访谈。');
  const segment = { id: uid(), sessionId: session.id, role: session.analysisVersion === 2 ? 'unknown' : session.role, original: trimmed, text: trimmed, source, createdAt: now(), revision: 0, edits: [], analyzedRevision: null };
  session.segments.push(segment);
  session.revision++;
  return segment;
}
export function correctSegment(session, id, text, role, roleSource = 'manual') {
  const seg = session.segments.find(s => s.id === id);
  if (!seg || !text.trim() || text.length > 12000) throw new Error('修正内容无效。');
  seg.edits.push({ text: seg.text, role: seg.role, at: now() });
  seg.text = text.trim(); seg.role = role.trim(); seg.roleSource = roleSource; seg.revision++; seg.analyzedRevision = null;
  // 对同一会话整体撤回派生结果，避免后续片段的判断间接依赖错误转写。
  session.events.push({ type: 'correction', segmentId: id, at: now(), priorClaims: clone(session.claims), priorQuestions: clone(session.questions), priorActions: clone(session.actions) });
  if (session.analysisVersion === 2) invalidateInterview(session);
  session.claims = []; if (session.analysisVersion !== 2) session.questions = []; session.actions = [];
  for (const s of session.segments) s.analyzedRevision = null;
  session.revision++;
}
export function itemStatus(session, itemId) {
  const claims = session.claims.filter(c => c.itemId === itemId);
  if (claims.some(c => c.status === 'conflict')) return 'conflict';
  if (claims.some(c => c.status === 'stated' && ['current', 'denial'].includes(c.kind))) return 'stated';
  if (claims.length) return 'vague';
  return 'unknown';
}
export function activeQuestion(session) {
  if (session.paused || session.endedAt) return null;
  if (session.analysisVersion === 2) return session.questions.find(q => q.id === session.displayedQuestionId && q.status === 'displayed') || null;
  for (let i = session.questions.length - 1; i >= 0; i--) if (session.questions[i].status === 'suggested') return session.questions[i];
  return null;
}
export function contextFor(topic, session, segment) {
  if (session.analysisVersion === 2) return interviewContext(topic, session, segment);
  // 全部原话仍保存在访谈中；请求使用有界滚动窗口，持续录音不因累计段数失效。
  const allSegments = topic.sessions.flatMap(s => s.segments.map(x => ({ id: x.id, text: x.text, role: x.role, sessionId: s.id })));
  let claimBudget = 20000;
  const candidates = topic.sessions.flatMap(s => s.claims.map(c => ({ ...c, sessionId: s.id }))).slice(-80).reverse().filter(c => { claimBudget -= c.text.length + c.quote.length; return claimBudget >= 0; }).reverse();
  const wanted = new Set([...allSegments.slice(-80).map(s => s.id), ...candidates.map(c => c.segmentId), segment.id]);
  let textBudget = 40000;
  const segments = [...allSegments].reverse().filter(s => { if (!wanted.has(s.id)) return false; if (s.id === segment.id) { textBudget -= s.text.length; return true; } if (s.text.length > textBudget) return false; textBudget -= s.text.length; return true; }).reverse();
  const included = new Set(segments.map(s => s.id));
  return {
    revision: session.revision, sessionId: session.id, segmentId: segment.id, goal: session.goal, role: segment.role,
    items: session.items, segments, claims: candidates.filter(c => included.has(c.segmentId)),
    questions: session.questions.slice(-100).map(q => ({ itemId: q.itemId, text: q.text, status: q.status, segmentId: q.segmentId }))
  };
}

const limitedString = (x, max = 1600) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
export function validateAnalysis(raw, context) {
  if (context.analysisVersion === 2) return validateInterview(raw, context);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.claims) || !Array.isArray(raw.actions) || !hasOwn(raw, 'question')) throw new Error('分析结果结构无效，未更新记录。');
  if (raw.claims.length > 30 || raw.actions.length > 20) throw new Error('分析结果超出条数限制。');
  const items = new Set(context.items.map(i => i.id));
  const segments = new Map(context.segments.map(s => [s.id, s]));
  const cite = value => {
    const s = segments.get(value.segmentId);
    if (!s || !limitedString(value.quote) || !s.text.includes(value.quote)) throw new Error('引用无法在原话中定位，未更新记录。');
    return { segmentId: s.id, quote: value.quote };
  };
  const claims = raw.claims.map(c => {
    if (!items.has(c.itemId) || !limitedString(c.text) || !hasOwn(STATUS, c.status) || !hasOwn(KIND, c.kind)) throw new Error('陈述字段无效，未更新记录。');
    if (c.segmentId !== context.segmentId) throw new Error('新增陈述必须引用当前输入片段。');
    return { ...cite(c), itemId: c.itemId, text: c.text, kind: c.kind, status: ['future', 'hypothesis', 'unknown'].includes(c.kind) && c.status === 'stated' ? 'vague' : c.status, evidence: '口头陈述' };
  });
  let question = null;
  if (raw.question !== null) {
    const q = raw.question;
    if (!q || !items.has(q.itemId) || !limitedString(q.text, 100) || !limitedString(q.gap, 500)) throw new Error('追问字段无效。');
    if (q.segmentId !== context.segmentId) throw new Error('追问需关联当前片段。');
    const duplicate = context.questions.some(old => old.text === q.text && ['asked', 'skipped', 'deferred'].includes(old.status));
    if (!duplicate) question = { ...cite(q), itemId: q.itemId, text: q.text, gap: q.gap, role: typeof q.role === 'string' ? q.role.slice(0, 100) : context.role };
  }
  const actions = raw.actions.map(a => {
    if (!limitedString(a.text)) throw new Error('后续行动无效。');
    if (a.segmentId !== context.segmentId) throw new Error('行动需关联当前片段。');
    // 不接受模型补全的负责人和日期；只能由用户会后编辑文字。
    return { ...cite(a), text: a.text, owner: '', due: '' };
  });
  return { claims, question, actions };
}
export function applyAnalysis(session, segment, raw, context, source) {
  if (session.analysisVersion === 2) return applyInterview(session, segment, raw, context, source);
  if (session.paused) throw new Error('访谈已暂停，旧分析已丢弃。');
  if (session.revision !== context.revision || session.id !== context.sessionId || segment.revision !== (context.segmentRevision ?? segment.revision) || session.endedAt) throw new Error('访谈已变化，旧分析已丢弃；请重新分析。');
  const result = validateAnalysis(raw, context);
  // 同片段重试替换派生分析，旧版本仍保存在事件记录中。
  session.events.push({ type: 'analysis', at: now(), segmentId: segment.id, source, priorClaims: clone(session.claims.filter(c => c.segmentId === segment.id)) });
  session.claims = session.claims.filter(c => c.segmentId !== segment.id);
  session.actions = session.actions.filter(a => a.segmentId !== segment.id);
  session.questions = session.questions.filter(q => !(q.segmentId === segment.id && q.status === 'suggested'));
  for (const q of session.questions) if (q.status === 'suggested') q.status = 'superseded';
  session.claims.push(...result.claims.map(c => ({ ...c, id: uid(), source, role: segment.role, createdAt: now() })));
  session.actions.push(...result.actions.map(a => ({ ...a, id: uid() })));
  if (result.question) session.questions.push({ ...result.question, id: uid(), source, status: 'suggested', createdAt: now() });
  segment.analyzedRevision = segment.revision;
  session.revision++;
  return result;
}
export function feedback(session, status) {
  const q = activeQuestion(session);
  if (!q || !['asked', 'skipped', 'deferred'].includes(status)) return;
  q.status = status; q.feedbackAt = now(); session.revision++;
}
export function exportMarkdown(topic) {
  const lines = [`# ${topic.title}`, '', '问全 · 访谈记录草案（需人工核对）', '', '原话只证明对方说过这些内容，不等于事实已核实。演示脚本不代表真实访谈。', ''];
  for (const s of topic.sessions) {
    lines.push(`## 访谈 ${topic.sessions.indexOf(s) + 1}`, '', `目标：${s.goal}`, `当前受访角色：${s.role}`, `开始：${s.startedAt}`, `结束：${s.endedAt || '进行中'}`, '');
    if (s.analysisVersion === 2) lines.push(interviewMarkdown(topic, s));
    else {
      lines.push('### 待确认清单', '');
      for (const item of s.items) lines.push(`- [${STATUS[itemStatus(s, item.id)]}] ${item.label}：${item.question}`);
      lines.push('', '### 陈述与原话', '');
      for (const c of s.claims) lines.push(`- ${c.text}（${KIND[c.kind]}；${c.evidence}；${c.role}；${c.source === 'demo' ? '离线脚本演示' : '模型分析'}）`, `  > ${c.quote}`, `  来源片段：${c.segmentId}`);
      if (!s.claims.length) lines.push('尚无已接受的分析。');
      lines.push('', '### 追问与反馈', '');
      for (const q of s.questions) lines.push(`- [${({ suggested: '建议', asked: '已问，等待回答', skipped: '已跳过', deferred: '稍后', superseded: '已被新结果替换' })[q.status]}] ${q.text}`, `  缺口：${q.gap}`, `  > ${q.quote}`);
      lines.push('', '### 后续行动', '');
      for (const a of s.actions) lines.push(`- ${a.text}；负责人：${a.owner || '未明确'}；期限：${a.due || '未明确'}`, `  > ${a.quote}`);
    }
    lines.push('', '### 对话片段', '');
    for (const seg of s.segments) lines.push(`#### ${seg.id} · ${seg.role} · ${seg.source === 'demo' ? '虚构演示' : seg.source === 'audio' ? '录音转写，待核对' : '手动文本'}`, '', seg.text, '', ...(seg.edits.length ? ['原始输入：', seg.original, `修正次数：${seg.edits.length}`, ''] : []));
  }
  if (topic.template === 'fde') lines.push('## FDE 发现草案', '', '第一版范围、当前流程、执行边界和验收条件，以以上具体陈述为依据；没有原话支持的事项仍待确认。未经客户核对，不作为获批范围或交付承诺。', '');
  return lines.join('\n');
}
