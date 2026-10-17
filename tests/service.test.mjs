import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../server/service.mjs';
import { analyze, checklist } from '../server/model.mjs';
import { newTopic, addSegment, contextFor } from '../web/core.js';
import { DEMOS, demoAnalysis } from '../web/fixtures.js';
import { upstreamFailure } from '../server/upstream.mjs';
const config = { base: 'https://model.invalid/v1', key: 'test-only-placeholder', model: 'test' };
function sample() {
  const topic = newTopic('research'), s = topic.sessions[0], seg = addSegment(s, DEMOS.research[0].text, 'demo');
  const context = { ...contextFor(topic, s, seg), segmentRevision: 0 };
  return { context, result: demoAnalysis('research', seg, context) };
}
const jsonModel = result => async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] });
test('真实模型适配器使用目标清单，双重校验逐字引用', async () => {
  const { context, result } = sample();
  let request;
  const received = await analyze(context, config, { fetchImpl: async (url, options) => { request = JSON.parse(options.body); return jsonModel(result)(); } });
  assert.equal(request.messages[0].role, 'system'); assert.equal(JSON.parse(request.messages[1].content).goal, context.goal);
  assert.equal(received.question.text, DEMOS.research[0].question);
  result.claims[0].quote = '虚构的引用';
  await assert.rejects(analyze(context, config, { fetchImpl: jsonModel(result) }), /引用/);
});
test('未配置模型、服务失败、截断和坏 JSON 不产生成功分析', async () => {
  const { context } = sample();
  await assert.rejects(analyze(context, { ...config, key: '' }), /尚未配置/);
  await assert.rejects(analyze(context, config, { fetchImpl: async () => new Response('', { status: 503 }) }), /503/);
  await assert.rejects(analyze(context, config, { fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'length' }] }) }), /截断/);
  await assert.rejects(analyze(context, config, { fetchImpl: async () => Response.json({ choices: [{ message: { content: 'not-json' } }] }) }), /无法解析/);
});
test('任意目标的候选清单经过结构校验', async () => {
  const input = { goal: '理解食堂排队时放弃购买的经过', role: '就餐同学' };
  const items = await checklist(input, config, { fetchImpl: jsonModel({ items: [{ label: '具体步骤', question: '你上次排到哪个位置时离开的？' }] }) });
  assert.equal(items.length, 1);
  await assert.rejects(checklist(input, config, { fetchImpl: jsonModel({ items: [{ label: 'x' }] }) }), /结构无效/);
});
test('HTTP 健康检查不泄露配置；缺少 ASR 和模型明确报错', async t => {
  const server = createService({ ALLOWED_ORIGINS: 'http://allowed.test' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.modelConfigured, false); assert.equal(health.asrConfigured, false); assert.equal(health.key, undefined);
  const blocked = await fetch(base + '/api/health', { headers: { Origin: 'http://untrusted.test' } }); assert.equal(blocked.status, 403);
  const preflight = await fetch(base + '/api/analyze', { method: 'OPTIONS', headers: { Origin: 'http://allowed.test' } }); assert.equal(preflight.status, 204);
  const studio = await fetch(base + '/api/health', { headers: { Origin: 'http://127.0.0.1:54344' } }); assert.equal(studio.status, 200); assert.equal(studio.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:54344');
  const { context } = sample();
  const missingModel = await fetch(base + '/api/analyze', { method: 'POST', body: JSON.stringify(context) }); assert.equal(missingModel.status, 503);
  const form = new FormData(); form.append('file', new Blob(['test-audio']), 'sample.ogg');
  const missingAsr = await fetch(base + '/api/transcribe', { method: 'POST', body: form }); assert.equal(missingAsr.status, 503);
  const page = await fetch(base + '/'); assert.equal(page.status, 200); assert.match(await page.text(), /问全/);
  const escape = await fetch(base + '/%2e%2e%2fpackage.json'); assert.equal(escape.status, 404);
});
test('ASR multipart 适配器传递 Ogg 并校验文本，不落盘', async t => {
  let sent = false;
  const server = createService({ ASR_API_KEY: 'test-only-placeholder' }, async (url, options) => {
    assert.match(url, /audio\/transcriptions$/); assert.equal(options.body.get('model'), 'whisper-1');
    assert.equal(await options.body.get('file').text(), 'OggS-test-audio'); sent = true;
    return Response.json({ text: '主管联系不上时，由值班经理接管。' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const form = new FormData(); form.append('file', new Blob(['OggS-test-audio']), 'sample.ogg');
  const result = await fetch(`http://127.0.0.1:${server.address().port}/api/transcribe`, { method: 'POST', body: form });
  assert.equal(result.status, 200); assert.ok(sent); assert.match((await result.json()).text, /值班经理/);
});
test('上游权限原因可见，同时清除密钥和 Bearer 凭据', async () => {
  const error = await upstreamFailure(Response.json({ error: { message: '该key不允许访问该模型 pk-sensitiveExample12345 Bearer other-secret-token' } }, { status: 400 }), '模型服务', ['pk-sensitiveExample12345']);
  assert.match(error.message, /不允许访问/); assert.doesNotMatch(error.message, /sensitiveExample|other-secret-token/);
});
test('WAV 上传使用真实格式；错误伪装不触发上游请求', async t => {
  let count = 0;
  const server = createService({ ASR_API_KEY: 'test-only-placeholder' }, async (_url, options) => {
    count++; const file = options.body.get('file'); assert.equal(file.name, 'interview.wav'); assert.equal(file.type, 'audio/wav');
    return Response.json({ text: '这是 WAV 转写测试。' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const form = new FormData(); form.append('file', new Blob(['RIFF0000WAVEfmt ']), 'mistaken.ogg');
  const response = await fetch(base + '/api/transcribe', { method: 'POST', body: form }); assert.equal(response.status, 200);
  const invalid = new FormData(); invalid.append('file', new Blob(['not-an-audio-file']), 'fake.wav');
  const rejected = await fetch(base + '/api/transcribe', { method: 'POST', body: invalid }); assert.equal(rejected.status, 400); assert.equal(count, 1);
});
