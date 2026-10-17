import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { openVolcStream } from './volc-stream.mjs';

export async function decodeFile(bytes, signal, executable = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, failed = false;
    const fail = error => { if (failed) return; failed = true; child.kill(); reject(error); };
    const abort = () => fail(new Error('音频转写已取消。'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => fail(new Error('音频解码超时。')), 15000);
    child.stdout.on('data', b => { size += b.length; if (size > 16000 * 2 * 120) fail(new Error('导入音频最长支持 2 分钟，请先截取较短片段。')); else chunks.push(b); });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => fail(new Error('音频解码器不可用，请在后端安装 ffmpeg。')));
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (failed) return; if (code || !size) reject(new Error('音频无法解码，请检查文件。')); else resolve(Buffer.concat(chunks)); });
    if (signal?.aborted) abort(); else child.stdin.end(bytes);
  });
}
export async function transcribeVolcFile(bytes, config, signal) {
  const pcm = await decodeFile(bytes, signal, config.ffmpeg);
  return new Promise((resolve, reject) => {
    let text = '', settled = false, upstream;
    const end = error => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); upstream?.cancel(); error ? reject(error) : text.trim() ? resolve(text.trim()) : reject(new Error('没有识别到有效文字。')); };
    const abort = () => end(new Error('音频转写已取消。'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      upstream = openVolcStream(config, { format: 'pcm', codec: 'raw', rate: 16000, channel: 1 }, {
        onResult: ({ result }) => { const r = Array.isArray(result) ? result[0] : result; if (typeof r?.text === 'string') text = r.text; },
        onError: end, onEnd: () => end(),
        onReady: () => { void (async () => { try { for (let i = 0; i < pcm.length && !settled; i += 6400) { upstream.send(pcm.subarray(i, i + 6400)); await delay(200, undefined, { signal }); } if (!settled) upstream.stop(); } catch (error) { end(error); } })(); }
      });
      if (signal?.aborted) abort();
    } catch (error) { end(error); }
  });
}
