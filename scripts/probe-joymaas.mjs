import { writeFile, mkdir } from 'node:fs/promises';
import { upstreamFailure } from '../server/upstream.mjs';
const key = process.env.JOYMAAS_API_KEY || process.env.MODEL_API_KEY;
if (!key) { console.error('本机 .env 中尚无 JOYMAAS_API_KEY。'); process.exit(1); }
const models = process.argv.slice(2).length ? process.argv.slice(2) : ['Qwen3.5-122B-A10B', 'JoyAI-VL-Interaction'];
const report = { testedAt: new Date().toISOString(), source: 'https://joymaas.jdcloud.com/models', syntheticInput: true, results: [] };
for (const model of models) {
  const started = Date.now();
  try {
    const response = await fetch('https://modelservice.jdcloud.com/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '目标：了解投诉升级流程。对方说“投诉件找主管”。请只用一句中文提出还没问清的一个问题。' }], max_tokens: 128, stream: false }),
      signal: AbortSignal.timeout(30000)
    });
    const result = { model, status: response.status, elapsedMs: Date.now() - started, success: false };
    if (response.ok) {
      const body = await response.json();
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim()) { result.success = true; result.output = content.replaceAll(key, '[已隐藏]').slice(0, 500); result.usage = body.usage; }
      else result.error = '上游响应无有效文本。';
    } else result.error = (await upstreamFailure(response, '模型服务', [key])).message;
    report.results.push(result);
  } catch (error) { report.results.push({ model, success: false, elapsedMs: Date.now() - started, error: error.name }); }
}
await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
await writeFile(new URL('../evidence/joymaas-live-probe.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
