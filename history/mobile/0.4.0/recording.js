import { OpusOggStream } from './ogg-stream.js';
import { TranscriptStream } from './transcript-stream.js';
import { endpoint } from './network.js';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function connectAsr(backend, callbacks = {}) {
  if (callbacks.signal?.aborted) throw callbacks.signal.reason || new Error('录音启动已取消。');
  callbacks.onStage?.('正在连接火山流式识别…');
  const url = endpoint(backend, '/api/asr/stream', true);
  const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
  let done = false, stopping = false, ready = false, resolveReady, rejectReady, resolveDone, rejectDone;
  const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const completed = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; }); completed.catch(() => {});
  const transcript = new TranscriptStream();
  const detach = () => callbacks.signal?.removeEventListener('abort', abort);
  const fail = error => { if (done) return; done = true; clearTimeout(timer); detach(); rejectReady(error); rejectDone(error); ws.close(); callbacks.onError?.(error); };
  const abort = () => fail(callbacks.signal.reason || new Error('录音启动已取消。'));
  callbacks.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => fail(new Error('火山语音连接超时，请检测后端配置。')), 20000);
  const audio = callbacks.audio || { format: 'ogg', codec: 'opus', rate: 16000, channel: 1 };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'start', audio, ...(callbacks.token ? { token: callbacks.token } : {}) }));
  ws.onmessage = event => {
    if (done) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'ready') { ready = true; clearTimeout(timer); resolveReady(); }
      else if (message.type === 'result') {
        const update = transcript.update(message.result, message.final);
        callbacks.onPartial?.(update.partial);
        for (const item of update.additions) callbacks.onFinal?.(item);
        for (const item of update.corrections) callbacks.onCorrection?.(item);
      } else if (message.type === 'error') fail(new Error(message.error || '火山语音识别失败。'));
      else if (message.type === 'done') { done = true; clearTimeout(timer); detach(); resolveDone(); ws.close(); callbacks.onDone?.(); }
    } catch (error) { fail(error); }
  };
  ws.onerror = () => fail(new Error('无法连接流式语音服务，请检测后端连接与配置。'));
  ws.onclose = () => { if (!done) fail(new Error('语音连接已断开，先前文字保留，请重新开始。')); };
  try { await readyPromise; } catch (error) { ws.close(); throw error; }
  return {
    send(bytes) { if (!ready || done || stopping || ws.readyState !== WebSocket.OPEN) throw new Error('语音连接已经停止。'); if (ws.bufferedAmount > 256 * 1024) { const error = new Error('音频网络积压，录音已停止，已有文字保留。'); fail(error); throw error; } ws.send(bytes); },
    async finish() { if (done) return completed; if (!stopping) { stopping = true; ws.send(JSON.stringify({ type: 'stop' })); } return completed; },
    cancel() { if (done) return; done = true; clearTimeout(timer); detach(); rejectReady(new Error('录音启动已取消。')); resolveDone(); if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cancel' })); ws.close(); }
  };
}

export async function startNativeRecording(gm, backend, callbacks) {
  let capture, client, reader, firstFrameTimer, cancelledReader, stoppedCapture, cancelled = false, stopping = false;
  const cleanup = () => {
    cancelled = true; clearTimeout(firstFrameTimer); client?.cancel();
    if (reader && cancelledReader !== reader) { cancelledReader = reader; void reader.cancel().catch(() => {}); }
    if (capture && stoppedCapture !== capture) { stoppedCapture = capture; void capture.stop().catch(() => {}); }
  };
  try {
    client = await connectAsr(backend, { ...callbacks, onError: error => { cleanup(); callbacks.onError?.(error); } });
    if (callbacks.isCancelled?.()) { cleanup(); throw new Error('录音启动已取消。'); }
    callbacks.onStage?.('云端已连接，正在打开眼镜麦克风；如有录音授权，请允许。');
    capture = await gm.audio.openCapture({ profile: 'custom', chunkDurationMs: 200, maxQueueMs: 3000, overflowStrategy: 'error', pickupMode: 'frontBalanced', noiseReduction: true, maxDurationMs: 3600000, ...(callbacks.signal ? { signal: callbacks.signal } : {}) });
    if (cancelled || callbacks.isCancelled?.()) { cleanup(); throw new Error('录音启动已取消。'); }
    const ogg = new OpusOggStream(); client.send(ogg.headers()); reader = capture.stream.getReader();
    callbacks.onStage?.('录音接口已打开，正在等待眼镜音频…');
    firstFrameTimer = setTimeout(() => {
      if (cancelled || stopping) return;
      cleanup(); callbacks.onError?.(new Error('录音接口已打开，但 8 秒内未收到眼镜音频。请确认眼镜已连接、录音权限已允许，且没有其他录音功能占用。'));
    }, callbacks.firstFrameTimeoutMs || 8000);
    const consuming = (async () => {
      try {
        let received = false;
        while (!cancelled) {
          const { value, done } = await reader.read(); if (done) break;
          if (!received) { received = true; clearTimeout(firstFrameTimer); callbacks.onStage?.('正在接收眼镜音频并实时转写。'); }
          client.send(ogg.push(value)); callbacks.onChunk?.(value.durationMs);
        }
        if (!cancelled) { client.send(ogg.end()); await client.finish(); }
      } catch (error) { if (!cancelled) { cleanup(); callbacks.onError?.(error); } }
      finally { clearTimeout(firstFrameTimer); reader.releaseLock(); callbacks.onStopped?.(); }
    })();
    return { source: 'native', async stop(discard = false) { if (stopping) return consuming; stopping = true; if (discard) cleanup(); else { try { await capture.stop(); } catch (error) { cleanup(); callbacks.onError?.(error); } } await consuming; }, cancel: cleanup };
  } catch (error) { cleanup(); throw error; }
}

export async function startFileReplay(blob, backend, callbacks) {
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  const context = new Context(); let decoded;
  try { decoded = await context.decodeAudioData(await blob.arrayBuffer()); } finally { await context.close(); }
  if (decoded.duration > 120) throw new Error('回放音频最长支持 2 分钟。');
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000), source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
  const samples = (await offline.startRendering()).getChannelData(0);
  let cancelled = false, stop = false, client;
  client = await connectAsr(backend, { ...callbacks, audio: { format: 'pcm', codec: 'raw', rate: 16000, channel: 1 }, onError: error => { cancelled = true; callbacks.onError?.(error); } });
  if (callbacks.isCancelled?.()) { client.cancel(); throw new Error('音频回放已取消。'); }
  const consuming = (async () => {
    try {
      for (let i = 0; i < samples.length && !stop && !cancelled; i += 3200) {
        const end = Math.min(i + 3200, samples.length), bytes = new Uint8Array((end - i) * 2), view = new DataView(bytes.buffer);
        for (let j = i; j < end; j++) view.setInt16((j - i) * 2, Math.round(Math.max(-1, Math.min(1, samples[j])) * 32767), true);
        client.send(bytes); callbacks.onChunk?.((end - i) / 16); await wait(200);
      }
      if (!cancelled) await client.finish();
    } catch (error) { if (!cancelled) callbacks.onError?.(error); client.cancel(); }
    finally { callbacks.onStopped?.(); }
  })();
  return { source: 'file', async stop(discard = false) { stop = true; if (discard) { cancelled = true; client.cancel(); } await consuming; }, cancel() { cancelled = true; client.cancel(); } };
}
