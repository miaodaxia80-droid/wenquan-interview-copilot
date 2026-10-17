import test from 'node:test';
import assert from 'node:assert/strict';
import { readModelStream } from '../server/model-stream.mjs';
import { readModelEvents, questionPreview } from '../web/model-stream.js';
import { createService } from '../server/service.mjs';
import { newTopic, addSegment, contextFor, validateAnalysis } from '../web/core.js';

function byteStream(text, stride = 7) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += stride) c.enqueue(bytes.slice(i, i + stride)); c.close(); } });
}
function sse(content, { finish = 'stop', done = true } = {}) {
  return new Response(byteStream(': keepalive\r\n\r\n' + [...content].map(text => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\r\n\r\n').join('') + 'data: ' + JSON.stringify({ choices: [{ finish_reason: finish }] }) + '\n\n' + (done ? 'data: [DONE]\n\n' : '')), { headers: { 'Content-Type': 'text/event-stream' } });
}
function sample() {
  const topic = newTopic('fde'), session = topic.sessions[0], seg = addSegment(session, '目前不允许AI修改工单。以后希望自动关闭，但尚未批准。', 'manual');
  const context = { ...contextFor(topic, session, seg), segmentRevision: seg.revision };
  const claim = { itemId: 'boundary', text: '禁止修改工单', kind: 'denial', status: 'stated', segmentId: seg.id, quote: '目前不允许AI修改工单。' };
  const result = { question: null, claims: [claim], actions: [] };
  return { context, result, claim };
}
test('上游 SSE 处理 UTF8 与 CRLF 拆包，内容增量早于完整结果', async () => {
  const text = '{"question":null,"claims":[],"actions":[],"说明":"中文🍎"}';
  let received = '';
  const result = await readModelStream(sse(text), { onDelta: delta => { received += delta; } });
  assert.equal(result, text); assert.equal(received, text);
});
test('上游缺失 DONE、截断或错误事件不会成为完整结果', async () => {
  await assert.rejects(readModelStream(sse('{}', { done: false })), /完整结束/);
  await assert.rejects(readModelStream(sse('{}', { finish: 'length' })), /截断/);
  await assert.rejects(readModelStream(new Response(byteStream('data: {"error":{"message":"secret upstream"}}\n\n'))), /模型流中断/);
});
test('上游挂起时取消立即释放 reader', async () => {
  const controller = new AbortController(); let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const pending = readModelStream(response, { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.ok(cancelled);
});
test('手机流式预览只使用追问字段，不把 JSON 或转义代码当界面', () => {
  assert.equal(questionPreview('{"question":{"itemId":"rules","text":"下一步怎么办？"'), '下一步怎么办？');
  assert.equal(questionPreview('{"claims":[{"text":"陈述"}]}'), '');
  assert.equal(questionPreview('{"question":{"text":"还没结束'), '');
});
test('手机网关流分块时先显示草稿，仅 result 返回正式分析', async () => {
  const result = { claims: [], question: null, actions: [] }, progress = [];
  const content = '{"question":{"text":"主管不回复时怎么办？"}}';
  const data = [{ type: 'start' }, ...[...content].map(text => ({ type: 'delta', text })), { type: 'result', result }].map(x => JSON.stringify(x) + '\n').join('');
  const value = await readModelEvents(new Response(byteStream(data)), { onProgress: p => progress.push(p) });
  assert.deepEqual(value.result, result); assert.equal(progress.at(-1).preview, '主管不回复时怎么办？');
  assert.ok(progress.length > 10);
});
test('手机流中断、错误、取消都不返回草稿作为正式结果', async () => {
  await assert.rejects(readModelEvents(new Response(byteStream('{"type":"delta","text":"{}"}\n'))), /提前结束/);
  await assert.rejects(readModelEvents(new Response(byteStream('{"type":"error","error":"引用无法定位"}\n'))), /引用/);
  const controller = new AbortController(); let cancelled = false;
  const pending = readModelEvents(new Response(new ReadableStream({ cancel() { cancelled = true; } })), { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.ok(cancelled);
});
test('未来计划不能标为已具体回答，同项的例外追问仍保留', () => {
  const { context, result, claim } = sample();
  result.claims.push({ ...claim, kind: 'future', text: '希望自动关闭', quote: '以后希望自动关闭，但尚未批准。' });
  result.question = { ...claim, text: '是否允许修改工单？', gap: '权限未知', role: context.role };
  const value = validateAnalysis(result, context);
  assert.equal(value.claims[1].status, 'vague'); assert.ok(value.question);
  result.claims[0].status = 'conflict'; assert.ok(validateAnalysis(result, context).question);
});
test('HTTP 流式接口鉴权并转发增量，完成后校验；旧 JSON 客户端继续可用', async t => {
  const { context, result } = sample(); let requested;
  const server = createService({ MODEL_BASE_URL: 'https://test.invalid', MODEL_API_KEY: 'test-only', MODEL_NAME: 'mini', MODEL_STREAM: 'true', MODEL_THINKING: 'disabled', GATEWAY_TOKEN: 'test-device-token-32-characters-long' }, async (_url, options) => {
    requested = JSON.parse(options.body); return sse(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/analyze`;
  assert.equal((await fetch(base, { method: 'POST', headers: { Accept: 'application/x-ndjson' }, body: JSON.stringify(context) })).status, 401);
  const headers = { Accept: 'application/x-ndjson', Authorization: 'Bearer test-device-token-32-characters-long' };
  const response = await fetch(base, { method: 'POST', headers, body: JSON.stringify(context) });
  assert.match(response.headers.get('Content-Type'), /ndjson/);
  const events = []; const value = await readModelEvents(response, { onProgress: p => events.push(p) });
  assert.ok(events.length > 1); assert.equal(value.result.claims[0].kind, 'denial');
  assert.equal(requested.stream, true); assert.equal(requested.thinking.type, 'disabled');
  delete headers.Accept;
  const legacy = await fetch(base, { method: 'POST', headers, body: JSON.stringify(context) });
  assert.equal((await legacy.json()).result.claims[0].kind, 'denial');
  result.claims[0].quote = '虚构'; headers.Accept = 'application/x-ndjson';
  await assert.rejects(readModelEvents(await fetch(base, { method: 'POST', headers, body: JSON.stringify(context) })), /引用/);
});
test('引用拒绝只重试一次并重置草稿，不返回第一次无效输出', async () => {
  const { analyze } = await import('../server/model.mjs');
  const { context, result } = sample(); let calls = 0, resets = 0;
  const fetchImpl = async () => { calls++; const copy = structuredClone(result); if (calls === 1) copy.claims[0].quote = '虚构'; return sse(JSON.stringify(copy)); };
  const config = { base: 'https://test.invalid', key: 'test-only', model: 'mini', stream: true, repair: true };
  const value = await analyze(context, config, { fetchImpl, onRetry: () => resets++ });
  assert.equal(calls, 2); assert.equal(resets, 1); assert.equal(value.claims[0].quote, result.claims[0].quote);
  calls = 0;
  await assert.rejects(analyze(context, config, { fetchImpl: async () => { calls++; const copy = structuredClone(result); copy.claims[0].quote = '仍然虚构'; return sse(JSON.stringify(copy)); } }), /引用/);
  assert.equal(calls, 2);
});
