import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { identifyRoles, summarize } from './intelligence.mjs';
import { analyze, checklist } from './model.mjs';
import { inspectAudio, MAX_AUDIO_BYTES } from '../web/audio-file.js';
import { upstreamFailure } from './upstream.mjs';
import { attachAsrSocket } from './volc-stream.mjs';
import { transcribeVolcFile } from './volc-file.mjs';
import { gatewayAuthorizer } from './auth.mjs';

const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
export function createService(env = process.env, fetchImpl = fetch) {
  const model = { base: env.MODEL_BASE_URL || 'https://api.openai.com/v1', key: env.MODEL_API_KEY, model: env.MODEL_NAME, stream: env.MODEL_STREAM === 'true', repair: env.MODEL_REPAIR === 'true', thinking: env.MODEL_THINKING === 'disabled' ? 'disabled' : undefined };
  const asr = { base: env.ASR_BASE_URL || 'https://api.openai.com/v1', key: env.ASR_API_KEY, model: env.ASR_MODEL || 'whisper-1' };
  const volc = { key: env.VOLC_ASR_API_KEY, url: env.VOLC_ASR_URL, resourceId: env.VOLC_ASR_RESOURCE_ID, ffmpeg: env.FFMPEG_PATH || 'ffmpeg' };
  const useVolc = env.ASR_PROVIDER === 'volcengine';
  const authorize = gatewayAuthorizer(env.GATEWAY_TOKEN);
  const asrConfigured = useVolc ? !!volc.key : !!asr.key;
  const allowed = new Set((env.ALLOWED_ORIGINS || 'http://127.0.0.1:8787,http://localhost:8787,http://127.0.0.1:4174,tauri://localhost,http://tauri.localhost,null').split(',').map(x => x.trim()));
  // Desktop Studio 每次启动使用随机的回环端口。仅本机开发默认允许这些页面。
  const isAllowed = origin => allowed.has(origin) || (!!env.GATEWAY_TOKEN && env.ALLOW_TOKEN_ORIGINS === 'true') || (env.ALLOW_LOOPBACK_ORIGINS !== 'false' && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin));
  let inflight = 0;
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    if (origin && !isAllowed(origin)) return send(403, { error: '此页面来源未获后端允许。' });
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    // 新版浏览器访问本机服务时可发出 Private Network Access 预检。
    if (req.headers['access-control-request-private-network'] === 'true' && origin && isAllowed(origin)) res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(400, { error: '请求地址无效。' }); }
    if (url.pathname.startsWith('/api/') && !authorize(req.headers.authorization?.replace(/^Bearer /, ''))) return send(401, { error: '网关访问码缺失或不正确，请在“分析设置”填写设备访问码。' });
    if (req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true, version: '0.5.0', analysisVersions: [1, 2], features: { batchAnalysis: true, automaticRoles: true, interviewSummary: true }, modelConfigured: !!(model.key && model.model), asrConfigured, nativeAppAsr: 'no-public-plugin-api-confirmed', model: { name: model.model || null, streaming: model.stream, configured: !!(model.key && model.model) }, asr: { name: useVolc ? '豆包流式语音识别 2.0 · Agent Plan' : asr.key ? asr.model : null, configured: asrConfigured, streaming: useVolc && !!volc.key, provider: useVolc ? 'volcengine' : 'openai-compatible', maxBytes: MAX_AUDIO_BYTES }, configurationIsNotVerification: true });
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (env.SERVE_WEB === 'false') return send(404, { error: '页面不存在。' });
      try {
        const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
        const path = resolve(root, `.${relative}`);
        if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) return send(404, { error: '页面不存在。' });
        const bytes = await readFile(path); res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes);
      } catch { send(404, { error: '页面不存在。请先运行 npm run build。' }); }
      return;
    }
    if (req.method !== 'POST' || !['/api/analyze', '/api/checklist', '/api/transcribe', '/api/identify-speakers', '/api/summarize'].includes(url.pathname)) return send(404, { error: '接口不存在。' });
    if (inflight >= 3) return send(429, { error: '正在处理其他片段，请稍后重试。' });
    inflight++;
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); }; res.on('close', onClose);
    try {
      const audio = url.pathname === '/api/transcribe';
      const limit = audio ? MAX_AUDIO_BYTES + 64 * 1024 : 2 * 1024 * 1024;
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('输入超出限制。'), { status: 413 }); chunks.push(chunk); }
      const body = Buffer.concat(chunks);
      if (audio) {
        if (!asrConfigured) throw Object.assign(new Error('尚未配置后端语音转写；可粘贴 Android App 的转写文本。'), { status: 503 });
        if (!req.headers['content-type']?.startsWith('multipart/form-data')) throw Object.assign(new Error('音频请求格式无效。'), { status: 400 });
        const form = await new Response(body, { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
        const file = form.get('file');
        const media = await inspectAudio(file);
        if (useVolc) {
          const text = await transcribeVolcFile(Buffer.from(await file.arrayBuffer()), volc, controller.signal);
          if (text.length > 12000) throw new Error('转写文字超限，请截取较短片段。');
          send(200, { text }); return;
        }
        const upstream = new FormData(); upstream.append('file', new Blob([file], { type: media.mime }), media.filename); upstream.append('model', asr.model); upstream.append('language', 'zh');
        const response = await fetchImpl(`${asr.base.replace(/\/$/, '')}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${asr.key}` }, body: upstream, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]) });
        if (!response.ok) throw await upstreamFailure(response, '转写服务', [asr.key]);
        const result = await response.json();
        if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 12000) throw Object.assign(new Error('转写结果为空或超限。'), { status: 502 });
        send(200, { text: result.text });
      } else {
        let input; try { input = JSON.parse(body.toString('utf8')); } catch { throw new Error('请求 JSON 无效。'); }
        const streaming = req.headers.accept?.includes('application/x-ndjson');
        const event = data => { if (!res.destroyed) res.write(JSON.stringify(data) + '\n'); };
        if (streaming) {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
          event({ type: 'start', model: model.model });
        }
        const options = { fetchImpl, signal: controller.signal, onRetry: streaming ? () => event({ type: 'reset' }) : undefined, onDelta: streaming ? text => event({ type: 'delta', text }) : undefined };
        const run = async () => {
          if (url.pathname === '/api/analyze') return { result: await analyze(input, model, options) };
          if (url.pathname === '/api/identify-speakers') return { result: await identifyRoles(input, model, options) };
          if (url.pathname === '/api/summarize') return { result: await summarize(input, model, { ...options, onProgress: streaming ? progress => event({type:'progress',...progress}) : undefined }) };
          return { items: await checklist(input, model, options) };
        };
        const value = await run();
        if (streaming) { event({type:'result',...value}); res.end(); return; }
        send(200,value);
      }
    } catch (error) {
      if (!res.destroyed && res.headersSent) { res.end(JSON.stringify({ type: 'error', error: error.name === 'TimeoutError' ? '服务超时，已有记录未变。' : error.message || '分析失败，原话已保留。' }) + '\n'); }
      else if (!res.destroyed) send(error.status || (error.name === 'TimeoutError' ? 504 : error.name === 'AbortError' ? 499 : 400), { error: error.name === 'TimeoutError' ? '服务超时，已有记录未变。' : error.name === 'TypeError' && error.message === 'fetch failed' ? '无法连接上游服务。' : error.message || '服务请求失败。' });
    } finally { inflight--; res.off('close', onClose); }
    // 不写入音频、对话文本、模型响应或密钥；上游服务留存规则由服务提供方决定。
  });
  attachAsrSocket(server, useVolc ? volc : {}, isAllowed, { authorize });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 8787);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.GATEWAY_TOKEN) throw new Error('对外监听必须配置 GATEWAY_TOKEN。');
  const server = createService();
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。` : '后端启动失败。'); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`问全本机服务已启动：http://${host}:${port}（不记录访谈正文）`));
}
