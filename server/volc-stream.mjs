import WebSocket, { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { PLAN_ASR_URL, encodeRequest, decodeResponse, asrRequest, safeAsrError } from './volc-protocol.mjs';

export function openVolcStream(config, audio, { onResult, onError, onEnd, onReady, WebSocketImpl = WebSocket } = {}) {
  if (!config.key) throw new Error('尚未配置火山 Agent Plan 语音 Key。');
  // 专属凭证仅发送到套餐 ASR 地址；不回退到按量付费入口。
  if ((config.url || PLAN_ASR_URL) !== PLAN_ASR_URL) throw new Error('火山语音地址必须使用 Agent Plan 套餐专用双向流式接口。');
  const payload = asrRequest(audio), id = randomUUID();
  const ws = new WebSocketImpl(PLAN_ASR_URL, { headers: { 'X-Api-Key': config.key, 'X-Api-Resource-Id': config.resourceId || 'volc.seedasr.sauc.duration', 'X-Api-Request-Id': id, 'X-Api-Connect-Id': id, 'X-Api-Sequence': '-1' }, handshakeTimeout: 12000, maxPayload: 1024 * 1024, perMessageDeflate: false });
  let sequence = 1, stopped = false, ended = false, accepted = false;
  const finish = () => { if (ended) return; ended = true; clearTimeout(timeout); clearTimeout(stopTimer); onEnd?.(); ws.close(); };
  const fail = error => { if (ended) return; onError?.(new Error(safeAsrError(error, config.key))); finish(); };
  const timeout = setTimeout(() => fail(new Error('语音服务未在时限内准备完成。')), 15000); let stopTimer;
  ws.on('open', () => ws.send(encodeRequest(1, sequence++, payload)));
  ws.on('message', bytes => {
    if (ended) return;
    try {
      const response = decodeResponse(bytes);
      if (response.code) throw new Error(`火山语音错误 ${response.code}：${response.data?.message || response.data?.error || '请求未成功'}`);
      if (!accepted) { accepted = true; clearTimeout(timeout); onReady?.(); }
      if (response.data?.result) onResult?.({ result: response.data.result, final: response.last });
      if (response.last) finish();
    } catch (error) { fail(error); }
  });
  ws.on('unexpected-response', (_req, response) => { response.resume(); fail(new Error(`火山语音鉴权/连接失败（HTTP ${response.statusCode}），请核对套餐 Key、语音额度与资源 ID。`)); });
  ws.on('error', fail);
  ws.on('close', () => { if (!ended) fail(new Error(stopped ? '语音连接在最终结果前关闭，尾句可能未完成。' : '语音连接意外断开，请重新开始录音。')); });
  return {
    send(bytes) {
      if (!accepted || stopped || ended) throw new Error('语音连接尚未就绪或已停止。');
      if (ws.bufferedAmount > 512 * 1024) throw new Error('语音网络积压，已停止采集以避免漏音。');
      ws.send(encodeRequest(2, sequence++, bytes));
    },
    stop() { if (stopped || ended) return; stopped = true; if (!accepted) { fail(new Error('语音连接尚未准备完成。')); return; } ws.send(encodeRequest(2, sequence++, Buffer.alloc(0), true)); stopTimer = setTimeout(() => fail(new Error('等待语音最终结果超时，已保留先前文字。')), 15000); },
    cancel() { if (ended) return; ended = true; clearTimeout(timeout); clearTimeout(stopTimer); ws.terminate(); }
  };
}

export function attachAsrSocket(server, config, isAllowed, { openStream = openVolcStream, authorize = () => true } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  let active = 0;
  server.on('upgrade', (req, socket, head) => {
    const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
    if (req.url !== '/api/asr/stream') return reject('404 Not Found');
    if (req.headers.origin && !isAllowed(req.headers.origin)) return reject('403 Forbidden');
    if (!config.key) return reject('503 Service Unavailable');
    if (active >= 2) return reject('429 Too Many Requests');
    wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client));
  });
  wss.on('connection', client => {
    active++; let upstream, started = false, ready = false, ending = false, received = 0, done = false;
    const send = value => { if (client.readyState === WebSocket.OPEN) { if (client.bufferedAmount > 1024 * 1024) return client.terminate(); client.send(JSON.stringify(value)); } };
    const idle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => fail('音频输入超时，连接已关闭。'), 12000); };
    let idleTimer = setTimeout(() => fail('未收到录音启动信息。'), 5000);
    const durationTimer = setTimeout(() => fail('本次连续录音达到 60 分钟，请重新开始一段。'), 60 * 60 * 1000);
    const cleanup = () => { if (done) return; done = true; active--; clearTimeout(idleTimer); clearTimeout(durationTimer); upstream?.cancel(); };
    const fail = error => { send({ type: 'error', error: safeAsrError(error, config.key) }); cleanup(); client.close(1011, 'ASR stopped'); };
    client.on('message', (bytes, binary) => {
      if (done) return;
      try {
        if (binary) {
          if (!ready || ending) throw new Error('音频连接未就绪或已停止。');
          received += bytes.length;
          if (received > 128 * 1024 * 1024) throw new Error('本次录音达到传输上限。');
          idle(); upstream.send(bytes); return;
        }
        if (bytes.length > 4096) throw new Error('语音控制消息超限。');
        const message = JSON.parse(bytes.toString());
        if (message.type === 'start' && !started) {
          if (!authorize(message.token)) throw new Error('网关访问码缺失或不正确，请在分析设置填写设备访问码。');
          started = true; clearTimeout(idleTimer);
          upstream = openStream(config, message.audio, {
            onReady: () => { if (done) return; ready = true; idle(); send({ type: 'ready' }); },
            onResult: value => send({ type: 'result', ...value }),
            onError: fail,
            onEnd: () => { if (done) return; send({ type: 'done' }); cleanup(); client.close(1000, 'done'); }
          });
        } else if (message.type === 'stop' && ready && !ending) { ending = true; clearTimeout(idleTimer); upstream.stop(); }
        else if (message.type === 'cancel') { cleanup(); client.close(1000, 'cancelled'); }
        else throw new Error('语音控制状态无效。');
      } catch (error) { fail(error); }
    });
    client.on('close', cleanup); client.on('error', cleanup);
  });
  server.on('close', () => { for (const client of wss.clients) client.terminate(); wss.close(); });
  return wss;
}
