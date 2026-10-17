export const LOCAL_BACKEND = 'http://127.0.0.1:8787';
export function isLoopback(value) {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname); } catch { return false; }
}
export function normalizeBackend(value, mobile = false) {
  if (!String(value || '').trim()) throw new Error('请先在“分析设置”填写云端网关地址。手机无需连接 Mac。');
  let url;
  try { url = new URL(value); } catch { throw new Error('网关地址无效，请填写完整 HTTPS 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('网关地址不能包含账号、密钥或查询参数。');
  if (mobile && isLoopback(url.href)) throw new Error('手机上的 127.0.0.1 / localhost 指向手机自身，无法访问 Mac；请改为云端 HTTPS 网关。');
  if (url.protocol !== 'https:' && !isLoopback(url.href)) throw new Error('实机请使用 HTTPS 网关，流式识别会自动使用 WSS。');
  return url.href.replace(/\/+$/, '');
}
export function endpoint(backend, path, websocket = false) {
  const url = new URL(normalizeBackend(backend) + path);
  if (websocket) url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
export function backendForHost(saved, transport, preferred = '', preconfigured = false) {
  if (preconfigured && (!saved || isLoopback(saved))) return preferred;
  if (transport === 'desktop-simulator') return saved || preferred || LOCAL_BACKEND;
  return (!saved || isLoopback(saved)) ? preferred : saved;
}
export function accessForGateway(backend, saved, preset) {
  const target = normalizeBackend(backend);
  if (saved?.backend && normalizeBackend(saved.backend) === target && saved.token) return saved.token;
  return preset?.gateway && normalizeBackend(preset.gateway) === target ? preset.token || '' : '';
}
export function networkFailure(error, backend, origin = '') {
  if (error?.name === 'AbortError') return error;
  if (error?.name === 'TimeoutError') return new Error('网关请求超时，请检查网络后重试；已有记录保留。');
  return new Error(`未收到网关响应（${backend || '未配置地址'}）。请检查手机联网、App 的 network 授权、HTTPS 证书及网关允许的页面来源。当前页面来源：${origin || '未知'}。`);
}
