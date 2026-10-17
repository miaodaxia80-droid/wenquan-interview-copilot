// 仅发送项目内系统合成语音；经与页面相同的本机 WebSocket 代理真实调用套餐 ASR。
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createService } from '../server/service.mjs';
import { decodeFile } from '../server/volc-file.mjs';
import { safeAsrError } from '../server/volc-protocol.mjs';
import { newTopic, addSegment, contextFor, applyAnalysis } from '../web/core.js';
import { OpusOggStream } from '../web/ogg-stream.js';
import { TranscriptStream } from '../web/transcript-stream.js';
import { spawnSync } from 'node:child_process';
import { analyze } from '../server/model.mjs';
const report = { at: new Date().toISOString(), source: 'macOS Tingting 系统合成语音，虚构工单流程', endpoint: '/api/v3/plan/sauc/bigmodel_async', resourceId: 'volc.seedasr.sauc.duration', realService: true, microphoneTested: false };
const server = createService(process.env); let ws;
try {
  const pcm = await decodeFile(await readFile(new URL('../evidence/ASR测试_系统合成语音.wav', import.meta.url)), AbortSignal.timeout(15000), process.env.FFMPEG_PATH || 'ffmpeg');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let resultCount = 0, definiteCount = 0, transcript = '', sentAll = false, intermediateBeforeEnd = false, firstResultMs;
  const oggMode = process.argv.includes('--ogg');
  let parts = [];
  if (oggMode) {
    const encoded = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0', '-c:a', 'libopus', '-frame_duration', '20', '-f', 'ogg', 'pipe:1'], { input: pcm, maxBuffer: 5 * 1024 * 1024 });
    if (encoded.status) throw new Error('合成语音 Opus 编码失败');
    const input = encoded.stdout, packets = []; let pending = [];
    for (let at = 0; at < input.length;) { const count = input[at + 26], lengths = input.subarray(at + 27, at + 27 + count); let offset = at + 27 + count; for (const n of lengths) { pending.push(input.subarray(offset, offset + n)); offset += n; if (n < 255) { packets.push(Buffer.concat(pending)); pending = []; } } at = offset; }
    const encoder = new OpusOggStream(); parts.push(encoder.headers());
    for (let i = 2; i < packets.length; i += 10) { const batch = packets.slice(i, i + 10); parts.push(encoder.push({ data: new Uint8Array(Buffer.concat(batch)), frameLengths: batch.map(x => x.length) })); }
    parts.push(encoder.end()); report.audioFormat = 'SDK-compatible 20 ms Opus → frontend incremental Ogg encoder';
  } else { for (let i = 0; i < pcm.length; i += 6400) parts.push(pcm.subarray(i, i + 6400)); report.audioFormat = 'PCM 16 kHz mono'; }
  let firstTextMs, intermediateTextBeforeEnd = false;
  const parsed = new TranscriptStream(), stable = new Map();
  const startedAt = Date.now();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws?.terminate(); reject(new Error('ASR 实测超时')); }, 40000);
    const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
    ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/asr/stream`, { origin: 'http://127.0.0.1:8787' });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'start', audio: { format: oggMode ? 'ogg' : 'pcm', codec: oggMode ? 'opus' : 'raw', rate: 16000, channel: 1 } })));
    ws.on('message', bytes => {
      const m = JSON.parse(bytes.toString());
      if (m.type === 'ready') void (async () => {
        try { for (const part of parts) { if (ws.readyState !== WebSocket.OPEN) return; ws.send(part); await delay(200); } sentAll = true; ws.send(JSON.stringify({ type: 'stop' })); } catch (error) { finish(error); }
      })();
      if (m.type === 'result') {
        try { const update = parsed.update(m.result, m.final); for (const item of [...update.additions, ...update.corrections]) stable.set(item.key, item); }
        catch (error) { finish(error); return; }
        resultCount++; firstResultMs ??= Date.now() - startedAt; if (!sentAll) intermediateBeforeEnd = true; const r = Array.isArray(m.result) ? m.result[0] : m.result; if (r.text) { firstTextMs ??= Date.now() - startedAt; if (!sentAll) intermediateTextBeforeEnd = true; } transcript = r.text || transcript; definiteCount = (r.utterances || []).filter(u => u.definite).length;
      }
      if (m.type === 'error') finish(new Error(m.error));
      if (m.type === 'done') { Object.assign(report, { succeeded: true, elapsedMs: Date.now() - startedAt, firstResultMs, firstTextMs, intermediateTextBeforeEnd, resultCount, definiteCount, intermediateBeforeEnd, transcript }); finish(); }
    });
    ws.on('error', finish); ws.on('close', () => { if (!report.succeeded) finish(new Error('代理在完成前关闭')); });
  });
  report.frontendParser = { stableSegments: [...stable.values()] };
  if (!stable.size) throw new Error('前端没有获得稳定转写分句');
  if (process.argv.includes('--with-model')) {
    const topic = newTopic('fde'), session = topic.sessions[0]; session.confirmed = true;
    const segment = addSegment(session, report.transcript, 'audio');
    const context = { ...contextFor(topic, session, segment), segmentRevision: segment.revision };
    const result = await analyze(context, { base: process.env.MODEL_BASE_URL, key: process.env.MODEL_API_KEY, model: process.env.MODEL_NAME });
    applyAnalysis(session, segment, result, context, 'model');
    report.model = { name: process.env.MODEL_NAME, succeeded: true, result };
  }
} catch (error) { report.succeeded = false; report.error = safeAsrError(error, process.env.VOLC_ASR_API_KEY); process.exitCode = 1; }
finally { ws?.terminate(); server.close(); await writeFile(new URL('../evidence/volc-asr-live-probe' + (process.argv.includes('--ogg') ? '-ogg' : '') + '.json', import.meta.url), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report, null, 2));
