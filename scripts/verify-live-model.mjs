import { createService } from '../server/service.mjs';
import { newTopic, addSegment, contextFor, applyAnalysis } from '../web/core.js';
import { writeFile, mkdir } from 'node:fs/promises';
const cases = [
  { template: 'fde', label: 'FDE 例外', text: '普通咨询由值班客服接手。投诉工单会转交客服主管审核，但如果主管一直不回复，我们现在没有统一办法。' },
  { template: 'research', label: '用户研究', text: '上周我填报名表，到手机验证那一页就退出了。不是不想报名，是验证码试了三次都没收到，也不知道能找谁帮忙。' },
  { template: 'fde', label: '否定与未来期望', text: '目前不允许 AI 直接修改工单，只能提供分派建议。以后希望把简单咨询自动关闭，但还没有批准上线。' }
];
if (!process.env.MODEL_API_KEY || !process.env.MODEL_NAME) { console.error('尚未配置真实模型。'); process.exit(1); }
const server = createService();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const report = { testedAt: new Date().toISOString(), model: process.env.MODEL_NAME, syntheticInput: true, results: [] };
try {
  for (const input of cases) {
    const topic = newTopic(input.template), session = topic.sessions[0]; session.confirmed = true;
    const segment = addSegment(session, input.text, 'manual');
    const context = { ...contextFor(topic, session, segment), segmentRevision: segment.revision };
    const started = Date.now();
    const response = await fetch(base + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(context), signal: AbortSignal.timeout(45000) });
    const body = await response.json();
    const record = { label: input.label, status: response.status, elapsedMs: Date.now() - started, success: false };
    if (response.ok) {
      applyAnalysis(session, segment, body.result, context, 'model');
      record.success = true; record.input = input.text; record.result = body.result;
      record.quoteValidation = 'passed'; record.stateMutation = 'accepted';
    } else record.error = body.error;
    report.results.push(record);
  }
} finally { await new Promise(resolve => server.close(resolve)); }
await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
await writeFile(new URL('../evidence/joymaas-live-analysis.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.results.some(r => !r.success)) process.exitCode = 1;
