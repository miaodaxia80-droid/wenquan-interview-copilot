// 仅使用项目内合成语音，真实经过公网 HTTPS/WSS 网关；访问码仅从环境读取。
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {roleContext,applyRoles} from '../web/intelligence.js';
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
const report = { at: new Date().toISOString(), gateway: base, source: 'macOS Tingting + Daniel 双合成声音，中英混合虚构访谈', physicalPhoneTested: false };
let ws;const taskDir=await mkdtemp(join(tmpdir(),'wenquan-dual-'));
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
  const parts=[];
  for(const [voice,line]of [['Tingting','我是今天的主持人小林。今天想了解你做项目的经历，你为什么开始做这个工具？'],['Daniel','I am the guest today. I started building a registration tool for our student club. Three strangers used it. I have not raised any money.']]){const file=join(taskDir,voice+'.aiff');if(spawnSync('say',['-v',voice,'-o',file,line]).status)throw new Error('合成声音失败');parts.push(await decodeFile(await readFile(file),AbortSignal.timeout(15000)),Buffer.alloc(16000));}
  const pcm=Buffer.concat(parts);
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
  const hostTopic=newTopic('host'),hs=hostTopic.sessions[0];
  for(const item of stable.values()){const seg=addSegment(hs,item.text,'audio');seg.role='unknown';seg.speakerKey=item.speakerId==null?null:'synthetic-stream:'+item.speakerId;}
  const rr=await fetch(endpoint(base,'/api/identify-speakers'),{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(roleContext(hs)),signal:AbortSignal.timeout(90000)});const roles=await rr.json();if(!rr.ok)throw new Error(roles.error||'自动角色接口失败');applyRoles(hs,roles.result,roleContext(hs));
  report.speakers={ids:[...new Set([...stable.values()].map(x=>x.speakerId).filter(x=>x!=null))],segments:hs.segments.map(x=>({text:x.text,speakerKey:x.speakerKey,role:x.role,roleSource:x.roleSource}))};
  if(report.speakers.ids.length<2||!hs.segments.some(x=>x.role==='host')||!hs.segments.some(x=>x.role==='guest'))throw new Error('双声音编号或自动角色未达到验收要求');
  report.succeeded = true;
} catch (error) { report.succeeded = false; report.error = safeAsrError(error, token); process.exitCode = 1; }
finally { ws?.terminate(); await rm(taskDir,{recursive:true,force:true}); await writeFile(new URL('../evidence/cloud-gateway-probe-0.4.0.json', import.meta.url), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report, null, 2));
