// 仅使用项目内合成语音，真实经过公网 HTTPS/WSS 网关；访问码仅从环境读取。
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { endpoint } from '../web/network.js';
import { TranscriptStream } from '../web/transcript-stream.js';
import { decodeFile } from '../server/volc-file.mjs';
import { safeAsrError } from '../server/volc-protocol.mjs';
import { newTopic, addSegment, contextFor, applyAnalysis } from '../web/core.js';
const base = process.env.WENQUAN_GATEWAY_URL;
const token = process.env.GATEWAY_TOKEN;
if (!base || !token) throw new Error('需要配置公网网关和设备访问码。');
const origin = 'https://mobile-webview.wenquan.invalid';
const headers = { Authorization: `Bearer ${token}`, Origin: origin };
const report = { at: new Date().toISOString(), gateway: base, source: '项目内 macOS Tingting 合成语音（虚构）', physicalPhoneTested: false };
let ws;
try {
  const unauth = await fetch(endpoint(base, '/api/health'));
  if (unauth.status !== 401) throw new Error('公网接口没有拒绝匿名调用');
  report.anonymousRejected = true;
  const preflight = await fetch(endpoint(base, '/api/health'), { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Headers': 'authorization' } });
  if (preflight.status !== 204 || preflight.headers.get('Access-Control-Allow-Origin') !== origin) throw new Error('手机跨域预检失败');
  report.corsPreflightPassed = true;
  const health = await fetch(endpoint(base, '/api/health'), { headers });
  if (!health.ok) throw new Error(`网关健康检查失败 HTTP ${health.status}`);
  report.health = await health.json();
  const pcm = await decodeFile(await readFile(new URL('../evidence/ASR测试_系统合成语音.wav', import.meta.url)), AbortSignal.timeout(15000));
  const parser = new TranscriptStream(), stable = new Map(); let sentAll = false, firstTextMs, text = '', intermediate = false;
  const start = Date.now();
  await new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => finish(new Error('公网流式测试超时')), 45000);
    const finish = error => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(); };
    ws = new WebSocket(endpoint(base, '/api/asr/stream', true), { origin });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'start', token, audio: { format: 'pcm', codec: 'raw', rate: 16000, channel: 1 } })));
    ws.on('message', bytes => {
      try {
        const message = JSON.parse(bytes);
        if (message.type === 'ready') void (async () => {
          try { for (let at = 0; at < pcm.length; at += 6400) { if (ws.readyState !== WebSocket.OPEN) return; ws.send(pcm.subarray(at, at + 6400)); await delay(200); } sentAll = true; ws.send('{"type":"stop"}'); } catch (error) { finish(error); }
        })();
        if (message.type === 'error') throw new Error(message.error);
        if (message.type === 'result') {
          const r = Array.isArray(message.result) ? message.result[0] : message.result;
          if (r.text) { firstTextMs ??= Date.now() - start; text = r.text; if (!sentAll) intermediate = true; }
          const update = parser.update(message.result, message.final);
          for (const item of [...update.additions, ...update.corrections]) stable.set(item.key, item);
        }
        if (message.type === 'done') finish();
      } catch (error) { finish(error); }
    });
    ws.on('error', finish); ws.on('close', () => { if (!finished) finish(new Error('公网连接在完成前断开')); });
  });
  if (!text || !stable.size || !intermediate) throw new Error('没有获得完整的中间和稳定转写结果');
  report.asr = { succeeded: true, intermediateBeforeAudioEnd: intermediate, firstTextMs, elapsedMs: Date.now() - start, text, stableCount: stable.size };
  const topic = newTopic('fde'), session = topic.sessions[0]; session.confirmed = true;
  const segment = addSegment(session, text, 'audio');
  const context = { ...contextFor(topic, session, segment), segmentRevision: segment.revision };
  const response = await fetch(endpoint(base, '/api/analyze'), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(context), signal: AbortSignal.timeout(45000) });
  const json = await response.json(); if (!response.ok) throw new Error(json.error || `模型 HTTP ${response.status}`);
  applyAnalysis(session, segment, json.result, context, 'model');
  report.model = { succeeded: true, question: json.result.question, claimsCount: json.result.claims.length };
  report.succeeded = true;
} catch (error) { report.succeeded = false; report.error = safeAsrError(error, token); process.exitCode = 1; }
finally { ws?.terminate(); await writeFile(new URL('../evidence/cloud-gateway-probe-0.2.5.json', import.meta.url), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report, null, 2));
