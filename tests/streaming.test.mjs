import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { once } from 'node:events';
import { encodeRequest, decodeResponse, asrRequest, safeAsrError } from '../server/volc-protocol.mjs';
import { attachAsrSocket, openVolcStream } from '../server/volc-stream.mjs';
import { TranscriptStream } from '../web/transcript-stream.js';
import { OpusOggStream } from '../web/ogg-stream.js';

function response(data, flags = 1) {
  const payload = gzipSync(JSON.stringify(data)), out = Buffer.alloc(12 + payload.length);
  out.set([0x11, 0x90 | flags, 0x11, 0]); out.writeInt32BE(flags & 2 ? -4 : 4, 4); out.writeUInt32BE(payload.length, 8); payload.copy(out, 12); return out;
}
test('火山二进制协议包含序号、gzip 和最终包标记；坏包被拒绝', () => {
  const first = encodeRequest(1, 1, { audio: { format: 'pcm' } });
  assert.equal(first[1], 0x11); assert.equal(first.readInt32BE(4), 1);
  assert.equal(JSON.parse(gunzipSync(first.subarray(12))).audio.format, 'pcm');
  const end = encodeRequest(2, 9, new Uint8Array(), true);
  assert.equal(end[1], 0x23); assert.equal(end.readInt32BE(4), -9);
  assert.equal(decodeResponse(response({ result: { text: '最终原话' } }, 3)).last, true);
  assert.throws(() => decodeResponse(Buffer.from([0x11, 0x91])), /协议头/);
  const bad = response({}); bad.writeUInt32BE(1, 8); assert.throws(() => decodeResponse(bad), /长度/);
});
test('专属 Key 不会被发到非套餐地址；仅接受明确的音频格式', () => {
  assert.throws(() => openVolcStream({ key: 'test-secret', url: 'wss://example.invalid' }, {}), /套餐/);
  assert.throws(() => asrRequest({ format: 'ogg', codec: 'raw', rate: 16000, channel: 1 }), /16 kHz/);
  const request = asrRequest({ format: 'ogg', codec: 'opus', rate: 16000, channel: 1 });
  assert.equal(request.request.enable_nonstream, true); assert.equal(request.request.enable_ddc, false);
  assert.doesNotMatch(safeAsrError(new Error('test-secret Bearer abc sk-sensitiveExample123'), 'test-secret'), /test-secret|abc|sensitiveExample/);
});
test('ASR 中间修订不入库，稳定句去重，尾包和后续修订显式返回', () => {
  const t = new TranscriptStream(), u = text => ({ start_time: 0, end_time: 900, text });
  assert.equal(t.update({ utterances: [u('主管不')] }).partial, '主管不');
  assert.equal(t.update({ utterances: [u('主管不在')] }).additions.length, 0);
  assert.equal(t.update({ utterances: [{ start_time: -1, end_time: -1, text: '未定位中间文字' }] }).partial, '未定位中间文字');
  assert.equal(t.update({ utterances: [{ ...u('主管不在找经理'), definite: true }] }).additions.length, 1);
  assert.equal(t.update({ utterances: [{ ...u('主管不在找经理'), definite: true }] }).additions.length, 0);
  assert.equal(t.update({ utterances: [{ ...u('主管不在找值班经理'), definite: true }] }).corrections.length, 1);
  assert.equal(t.update({ utterances: [{ start_time: 1000, end_time: 1600, text: '尾句' }] }, true).additions[0].text, '尾句');
  const missing = { utterances: [{ start_time: -1, end_time: -1, definite: true, text: '未定位尾句' }] };
  const item = t.update(missing).additions[0];
  assert.equal(item.text, '未定位尾句'); assert.equal(item.timingUnavailable, true); assert.equal(item.startMs, undefined);
  assert.equal(t.update(missing, true).additions.length, 0);
});
test('增量 Ogg 保留序号、48k granule、EOS；丢帧不能静默拼接', () => {
  const ogg = new OpusOggStream(42), header = ogg.headers();
  assert.equal(Buffer.from(header).subarray(28, 36).toString(), 'OpusHead');
  const frame = ogg.push({ data: new Uint8Array([0xf8, 0xff, 0xfe]), frameLengths: [3] }), view = new DataView(frame.buffer);
  assert.equal(view.getUint32(6, true), 960); assert.equal(view.getUint32(18, true), 2);
  assert.equal(ogg.end()[5], 4); assert.throws(() => ogg.push({}), /结束/);
  const invalid = new OpusOggStream(); assert.throws(() => invalid.push({ discontinuity: true }), /丢帧/);
  assert.throws(() => invalid.push({ data: new Uint8Array([1]), frameLengths: [2] }), /边界/);
});

test('WebSocket 代理在上游确认后才接收音频，停止会等最终结果，拒绝外部来源', async t => {
  const server = http.createServer(); let received = 0, cancelled = 0;
  attachAsrSocket(server, { key: 'test-only' }, origin => origin === 'http://allowed.test', { openStream: (_config, audio, callbacks) => {
    assert.equal(audio.format, 'pcm'); queueMicrotask(callbacks.onReady);
    return { send(bytes) { received += bytes.length; callbacks.onResult({ result: { text: '中间结果' }, final: false }); }, stop() { callbacks.onResult({ result: { text: '最终结果' }, final: true }); callbacks.onEnd(); }, cancel() { cancelled++; } };
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.address().port}/api/asr/stream`;
  const client = new WebSocket(url, { origin: 'http://allowed.test' }); t.after(() => client.terminate());
  const messages = []; client.on('message', b => messages.push(JSON.parse(b)));
  await once(client, 'open'); client.send(JSON.stringify({ type: 'start', audio: { format: 'pcm' } }));
  await once(client, 'message'); assert.equal(messages[0].type, 'ready');
  client.send(Buffer.alloc(6400)); await once(client, 'message'); assert.equal(received, 6400);
  client.send(JSON.stringify({ type: 'stop' })); await once(client, 'close');
  assert.ok(messages.some(m => m.type === 'result' && m.final)); assert.equal(messages.at(-1).type, 'done'); assert.equal(cancelled, 1);
  const rejected = new WebSocket(url, { origin: 'http://untrusted.test' }); rejected.on('error', () => {});
  const [, res] = await once(rejected, 'unexpected-response'); assert.equal(res.statusCode, 403); rejected.terminate();
});
test('浏览器断开会取消云端连接，不继续发送音频', async t => {
  const server = http.createServer(); let cancel;
  const cancelled = new Promise(resolve => { cancel = resolve; });
  attachAsrSocket(server, { key: 'test-only' }, () => true, { openStream: (_c, _a, callbacks) => { queueMicrotask(callbacks.onReady); return { cancel, send() {}, stop() {} }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/asr/stream`); await once(client, 'open'); client.send(JSON.stringify({ type: 'start' })); await once(client, 'message'); client.terminate(); await cancelled;
});

test('长访谈保留全部原话，模型上下文滚动限长并保留当前片段', async () => {
  const { newTopic, addSegment, contextFor } = await import('../web/core.js');
  const { validateContext } = await import('../server/model.mjs');
  const topic = newTopic('fde'), session = topic.sessions[0]; let segment;
  for (let i = 0; i < 350; i++) segment = addSegment(session, `第 ${i} 段：` + '访谈原话'.repeat(50), 'audio');
  const context = { ...contextFor(topic, session, segment), segmentRevision: segment.revision };
  validateContext(context); assert.equal(session.segments.length, 350); assert.ok(context.segments.length <= 160);
  assert.ok(context.segments.some(s => s.id === segment.id)); assert.ok(context.segments.reduce((n, s) => n + s.text.length, 0) <= 40000);
});

test('持续采集不是先缓存整段；停止会排空原生流并发送最终控制包', async t => {
  const { startNativeRecording } = await import('../web/recording.js');
  const original = globalThis.WebSocket, sent = []; let controller, stopCount = 0;
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 1; this.bufferedAmount = 0; queueMicrotask(() => this.onopen?.()); }
    send(data) {
      sent.push(data);
      if (typeof data === 'string') {
        const m = JSON.parse(data);
        if (m.type === 'start') queueMicrotask(() => this.onmessage({ data: '{"type":"ready"}' }));
        if (m.type === 'stop') queueMicrotask(() => this.onmessage({ data: '{"type":"done"}' }));
      }
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  globalThis.WebSocket = Socket; t.after(() => { globalThis.WebSocket = original; });
  const stream = new ReadableStream({ start(c) { controller = c; } });
  const gm = { audio: { async openCapture(options) { assert.equal(options.chunkDurationMs, 200); assert.equal(options.maxDurationMs, 3600000); return { stream, async stop() { stopCount++; controller.close(); } }; } } };
  const recording = await startNativeRecording(gm, 'http://127.0.0.1:8787', {});
  const before = sent.length; controller.enqueue({ data: new Uint8Array([0xf8, 0xff, 0xfe]), frameLengths: [3], durationMs: 20 });
  await new Promise(resolve => setImmediate(resolve)); assert.ok(sent.length > before, '停止前已发送音频');
  assert.ok(!sent.some(x => typeof x === 'string' && JSON.parse(x).type === 'stop'));
  await recording.stop(); assert.equal(stopCount, 1);
  assert.equal(JSON.parse(sent.at(-1)).type, 'stop'); assert.equal(sent.at(-2)[5], 4, 'Ogg EOS 先于停止控制包');
});

test('文件选择器关闭后等待前台恢复，仅重试 NOT_FOREGROUND，不吞真实权限错误', async () => {
  const { readSelectedFile } = await import('../web/foreground.js');
  let states = 0, reads = 0;
  const gm = { runtime: { async getLifecycleState() { return { state: ++states === 1 ? 'suspended' : 'running' }; } }, files: { async openRead(id) { assert.equal(id, 'selected'); if (++reads === 1) throw new Error('NOT_FOREGROUND'); return { stream: 'test-stream' }; } } };
  assert.equal((await readSelectedFile(gm, 'selected', { intervalMs: 1 })).stream, 'test-stream'); assert.equal(reads, 2);
  gm.files.openRead = async () => { throw new Error('PERMISSION_DENIED'); };
  await assert.rejects(readSelectedFile(gm, 'selected', { intervalMs: 1 }), /PERMISSION_DENIED/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(readSelectedFile(gm, 'selected', { signal: controller.signal }), { name: 'AbortError' });
});

test('云端连接等待可取消，不留下 WebSocket 或继续打开麦克风', async t => {
  const { connectAsr } = await import('../web/recording.js');
  const original = globalThis.WebSocket; let socket;
  class Socket {
    static OPEN = 1;
    constructor() { socket = this; this.readyState = 0; }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  globalThis.WebSocket = Socket; t.after(() => { globalThis.WebSocket = original; });
  const controller = new AbortController(), pending = connectAsr('https://cloud.test/wenquan', { signal: controller.signal });
  controller.abort(new Error('取消启动测试'));
  await assert.rejects(pending, /取消启动测试/);
  assert.equal(socket.readyState, 3);
});

test('采集打开却无首帧时停止流并显示连接和权限提示', async t => {
  const { startNativeRecording } = await import('../web/recording.js');
  const original = globalThis.WebSocket; let stopped = 0, streamCancelled = 0, socket;
  class Socket {
    static OPEN = 1;
    constructor() { socket = this; this.readyState = 1; this.bufferedAmount = 0; queueMicrotask(() => this.onopen?.()); }
    send(data) { if (typeof data === 'string' && JSON.parse(data).type === 'start') queueMicrotask(() => this.onmessage({ data: '{"type":"ready"}' })); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  globalThis.WebSocket = Socket; t.after(() => { globalThis.WebSocket = original; });
  const stream = new ReadableStream({ cancel() { streamCancelled++; } });
  const gm = { audio: { async openCapture() { return { stream, async stop() { stopped++; } }; } } };
  let notifyError; const error = new Promise(resolve => { notifyError = resolve; });
  const recording = await startNativeRecording(gm, 'https://cloud.test/wenquan', { firstFrameTimeoutMs: 5, onError: notifyError });
  assert.match((await error).message, /未收到眼镜音频.*录音权限/);
  await recording.stop(true);
  assert.equal(stopped, 1); assert.equal(streamCancelled, 1); assert.equal(socket.readyState, 3);
});
