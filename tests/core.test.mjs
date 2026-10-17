import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, newTopic, newSession, current, addSegment, contextFor, applyAnalysis, validateAnalysis, itemStatus, activeQuestion, feedback, correctSegment, exportMarkdown, clone } from '../web/core.js';
import { DEMOS, demoAnalysis } from '../web/fixtures.js';

function setup(template = 'fde', step = 0) {
  const topic = newTopic(template), session = topic.sessions[0]; session.confirmed = true;
  const segment = addSegment(session, DEMOS[template][step].text, 'demo');
  const context = { ...contextFor(topic, session, segment), segmentRevision: segment.revision };
  const result = demoAnalysis(template, segment, context);
  return { topic, session, segment, context, result };
}
test('FDE 与用户研究使用同一内核，追问依据可定位', () => {
  for (const template of ['fde', 'research']) {
    const x = setup(template); applyAnalysis(x.session, x.segment, x.result, x.context, 'demo');
    assert.equal(x.session.claims.length, 1);
    assert.ok(x.segment.text.includes(activeQuestion(x.session).quote));
    assert.equal(itemStatus(x.session, x.result.claims[0].itemId), 'vague');
  }
});
test('自由输入不会被固定脚本冒充为模型结果', () => {
  const x = setup(); x.segment.source = 'manual';
  assert.throws(() => demoAnalysis('fde', x.segment, x.context), /自由输入/);
});
test('脚本内容修改后不能继续套用固定结果', () => {
  const x = setup(); x.segment.text += '修正';
  assert.throws(() => demoAnalysis('fde', x.segment, x.context), /已经修改/);
});
test('已问只改变提问状态，不把含糊事项标为已解决', () => {
  const x = setup(); applyAnalysis(x.session, x.segment, x.result, x.context, 'demo');
  feedback(x.session, 'asked');
  assert.equal(activeQuestion(x.session), null); assert.equal(itemStatus(x.session, 'boundary'), 'vague');
  assert.equal(x.session.questions[0].status, 'asked');
});
test('暂停隐藏建议，恢复后保持同一条；结束始终无提示', () => {
  const x = setup(); applyAnalysis(x.session, x.segment, x.result, x.context, 'demo');
  const id = activeQuestion(x.session).id;
  x.session.paused = true; assert.equal(activeQuestion(x.session), null);
  x.session.paused = false; assert.equal(activeQuestion(x.session).id, id);
  x.session.endedAt = new Date().toISOString(); assert.equal(activeQuestion(x.session), null);
});
test('未知引文、片段与清单 ID 都在写入前被拒绝', () => {
  for (const mutation of [r => r.claims[0].quote = '不存在的原话', r => r.claims[0].segmentId = 'missing', r => r.claims[0].itemId = 'missing', r => r.question.quote = '幻觉', r => r.actions = [{ text: '去确认', quote: '幻觉', segmentId: 'missing' }]]) {
    const x = setup(), before = clone(x.session); mutation(x.result);
    assert.throws(() => applyAnalysis(x.session, x.segment, x.result, x.context, 'model'));
    assert.deepEqual(x.session, before);
  }
});
test('非法状态、缺少 question、超长追问均不接受', () => {
  for (const mutation of [r => r.claims[0].status = 'verified', r => delete r.question, r => r.question.text = '问'.repeat(101)]) {
    const x = setup(); mutation(x.result); assert.throws(() => validateAnalysis(x.result, x.context));
  }
});
test('空结果是合法结果，并撤回上一条过期提示', () => {
  const x = setup(); applyAnalysis(x.session, x.segment, x.result, x.context, 'demo');
  const seg = addSegment(x.session, '先说到这里。');
  applyAnalysis(x.session, seg, { claims: [], question: null, actions: [] }, contextFor(x.topic, x.session, seg), 'model');
  assert.equal(activeQuestion(x.session), null); assert.equal(x.session.questions[0].status, 'superseded');
});
test('晚到结果、已结束会话和角色更新不会覆盖当前状态', () => {
  for (const mutate of [s => s.revision++, s => s.endedAt = new Date().toISOString(), s => s.id = 'new-session']) {
    const x = setup(); mutate(x.session); const before = clone(x.session);
    assert.throws(() => applyAnalysis(x.session, x.segment, x.result, x.context, 'model'), /旧分析/);
    assert.deepEqual(x.session, before);
  }
});
test('更正保留原输入及分析历史，撤回全部派生结果', () => {
  const x = setup(); applyAnalysis(x.session, x.segment, x.result, x.context, 'demo');
  correctSegment(x.session, x.segment.id, '现在不允许 AI 修改工单。', '一线客服');
  assert.equal(x.segment.original, DEMOS.fde[0].text); assert.equal(x.segment.edits.length, 1);
  assert.equal(x.session.claims.length, 0); assert.equal(x.session.questions.length, 0);
  assert.equal(x.segment.analyzedRevision, null); assert.equal(x.session.events.at(-1).priorClaims.length, 1);
});
test('未来期望和假设不能充当具体当前陈述，明确否定保留类型', () => {
  const x = setup();
  x.result.claims[0].status = 'stated'; x.result.claims[0].kind = 'future';
  applyAnalysis(x.session, x.segment, x.result, x.context, 'model');
  assert.equal(itemStatus(x.session, 'boundary'), 'vague');
  x.session.claims.push({ itemId: 'boundary', status: 'stated', kind: 'denial' });
  assert.equal(itemStatus(x.session, 'boundary'), 'stated');
  x.session.claims.push({ itemId: 'boundary', status: 'conflict', kind: 'current' });
  assert.equal(itemStatus(x.session, 'boundary'), 'conflict');
});
test('重试不重复累计陈述；跳过的问题不会重新显示', () => {
  const x = setup(); applyAnalysis(x.session, x.segment, x.result, x.context, 'demo'); feedback(x.session, 'skipped');
  const context = contextFor(x.topic, x.session, x.segment);
  applyAnalysis(x.session, x.segment, x.result, context, 'demo');
  assert.equal(x.session.claims.length, 1); assert.equal(activeQuestion(x.session), null);
});
test('跨会续接保留历史来源；不同主题隔离', () => {
  const x = setup(); applyAnalysis(x.session, x.segment, x.result, x.context, 'demo');
  const next = newSession('fde', x.topic.id, x.session.items); x.topic.sessions.push(next);
  const seg = addSegment(next, '补充一条说明。'); const context = contextFor(x.topic, next, seg);
  assert.equal(context.claims.length, 1); assert.equal(context.claims[0].sessionId, x.session.id);
  const other = newTopic('research'); const otherSeg = addSegment(other.sessions[0], '新的访谈。');
  assert.equal(contextFor(other, other.sessions[0], otherSeg).claims.length, 0);
});
test('行动不接受模型补造的姓名和期限；导出准确标注演示与未知', () => {
  const x = setup('fde', 3); x.result.actions[0].owner = '模型编造的人'; x.result.actions[0].due = '明天';
  applyAnalysis(x.session, x.segment, x.result, x.context, 'demo');
  assert.equal(x.session.actions[0].owner, ''); assert.equal(x.session.actions[0].due, '');
  const md = exportMarkdown(x.topic);
  assert.match(md, /虚构演示/); assert.match(md, /负责人：未明确/); assert.match(md, /期限：未明确/); assert.match(md, /FDE 发现草案/); assert.doesNotMatch(md, /模型编造的人/);
});
test('空文本、超长文本和已结束访谈不增加片段', () => {
  const s = current(newState()).session;
  assert.throws(() => addSegment(s, ' ')); assert.throws(() => addSegment(s, '字'.repeat(12001)));
  s.endedAt = new Date().toISOString(); assert.throws(() => addSegment(s, '正文')); assert.equal(s.segments.length, 0);
});
