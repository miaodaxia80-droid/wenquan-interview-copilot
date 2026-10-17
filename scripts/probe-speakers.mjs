// 仅用两种系统合成语音核对当前 Agent Plan 的说话人分离能力，不采集真人声纹。
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { PLAN_ASR_URL, asrRequest, encodeRequest, decodeResponse, safeAsrError } from '../server/volc-protocol.mjs';
import { decodeFile } from '../server/volc-file.mjs';
const report = { at: new Date().toISOString(), endpoint: PLAN_ASR_URL, syntheticOnly: true, physicalMicrophone: false, productionChanged: false };
const taskDir = await mkdtemp(join(tmpdir(), 'wenquan-speakers-')); let ws;
try {
  const second = join(taskDir, 'second.aiff');
  const spoken = spawnSync('say', ['-v', 'Daniel', '-o', second, 'When the supervisor is not available, the duty manager handles the complaint. This is a synthetic interview test.']);
  if (spoken.status) throw new Error('第二种系统合成声音生成失败');
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const firstPcm = await decodeFile(await readFile(new URL('../evidence/ASR测试_系统合成语音.wav', import.meta.url)), AbortSignal.timeout(15000), ffmpeg);
  const secondPcm = await decodeFile(await readFile(second), AbortSignal.timeout(15000), ffmpeg);
  const pcm = Buffer.concat([firstPcm, Buffer.alloc(16000), secondPcm]);
  report.durationMs = pcm.length / 32;
  const request = asrRequest({ format: 'pcm', codec: 'raw', rate: 16000, channel: 1 });
  Object.assign(request.request, { enable_speaker_info: true, ssd_version: '200' });
  const speakerIds = new Set(); let finalUtterances = [], responsesWithSpeaker = 0, sequence = 1;
  await new Promise((resolve, reject) => {
    let finished = false, sending = false;
    const timer = setTimeout(() => finish(new Error('说话人分离实测超时')), 50000);
    const finish = error => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(); };
    const id = randomUUID();
    ws = new WebSocket(PLAN_ASR_URL, { headers: { 'X-Api-Key': process.env.VOLC_ASR_API_KEY, 'X-Api-Resource-Id': 'volc.seedasr.sauc.duration', 'X-Api-Request-Id': id, 'X-Api-Connect-Id': id, 'X-Api-Sequence': '-1' }, handshakeTimeout: 12000 });
    ws.on('open', () => ws.send(encodeRequest(1, sequence++, request)));
    ws.on('unexpected-response', (_req, res) => { res.resume(); finish(new Error('接口拒绝请求 HTTP '+res.statusCode)); });
    ws.on('error', finish);
    ws.on('close', () => { if (!finished) finish(new Error('最终结果之前连接关闭')); });
    ws.on('message', bytes => {
      try {
        const response = decodeResponse(bytes);
        if (response.code) throw new Error('接口错误 '+response.code+': '+(response.data.message || response.data.error || 'unknown'));
        if (!sending) { sending = true; void (async () => {
          for (let offset=0; offset<pcm.length && !finished; offset+=6400) { ws.send(encodeRequest(2, sequence++, pcm.subarray(offset,offset+6400))); await delay(200); }
          if (!finished) ws.send(encodeRequest(2, sequence++, Buffer.alloc(0), true));
        })().catch(finish); }
        const result = Array.isArray(response.data.result) ? response.data.result[0] : response.data.result;
        const utterances = result?.utterances || [];
        for (const u of utterances) {
          const speaker = u.additions?.speaker_id ?? u.additions?.speaker ?? u.speaker_id ?? u.speaker;
          if (speaker != null && String(speaker) !== '') { speakerIds.add(String(speaker)); responsesWithSpeaker++; }
        }
        if (response.last) { report.finalResult = result; finalUtterances = utterances.map(u=>({ text:u.text, speaker:u.additions?.speaker_id ?? u.additions?.speaker ?? u.speaker_id ?? u.speaker ?? null, definite:!!u.definite })); finish(); }
      } catch (error) { finish(error); }
    });
  });
  Object.assign(report, { requestAccepted: true, speakerIds: [...speakerIds], responsesWithSpeaker, finalUtterances, speakerIdsReturned: !!speakerIds.size });
} catch (error) { report.error = safeAsrError(error, process.env.VOLC_ASR_API_KEY); process.exitCode=1; }
finally { ws?.terminate(); await rm(taskDir,{recursive:true,force:true}); await writeFile(new URL('../evidence/speaker-capability-probe.json',import.meta.url),JSON.stringify(report,null,2)+'\n'); }
console.log(JSON.stringify(report,null,2));
