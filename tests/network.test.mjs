import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { backendForHost, normalizeBackend, accessForGateway, endpoint, networkFailure } from '../web/network.js';
import { createService } from '../server/service.mjs';
import { gatewayAuthorizer } from '../server/auth.mjs';
import { attachAsrSocket } from '../server/volc-stream.mjs';

test('手机拒绝回环地址和非 HTTPS，桌面保留本机开发，云端路径迁移不丢访谈', () => {
  assert.throws(() => normalizeBackend('http://127.0.0.1:8787', true), /手机自身/);
  assert.throws(() => normalizeBackend('http://192.168.1.2:8787', true), /HTTPS/);
  assert.throws(() => normalizeBackend('https://a.test/?key=secret'), /密钥/);
  assert.throws(() => normalizeBackend(''), /云端网关/);
  assert.equal(backendForHost('http://127.0.0.1:8787', 'desktop-simulator', 'https://cloud.test/wenquan'), 'http://127.0.0.1:8787');
  assert.equal(backendForHost('http://127.0.0.1:8787', 'bluetooth', 'https://cloud.test/wenquan'), 'https://cloud.test/wenquan');
  assert.equal(backendForHost('https://own.test', 'bluetooth', 'https://cloud.test/wenquan'), 'https://own.test');
  assert.equal(endpoint('https://cloud.test/wenquan/', '/api/asr/stream', true), 'wss://cloud.test/wenquan/api/asr/stream');
  assert.equal(endpoint('https://cloud.test/wenquan', '/api/health'), 'https://cloud.test/wenquan/api/health');
  assert.match(networkFailure(new TypeError('fetch failed'), 'https://cloud.test', 'null').message, /network 授权/);
});
test('预置连接在新装及桌面旧回环地址下直接可用，手动云端地址继续保留', () => {
  const cloud = 'https://cloud.test/wenquan';
  assert.equal(backendForHost('', 'bluetooth', cloud, true), cloud);
  assert.equal(backendForHost('http://127.0.0.1:8787', 'desktop-simulator', cloud, true), cloud);
  assert.equal(backendForHost('http://127.0.0.1:8790', 'desktop-simulator', cloud, true, true), 'http://127.0.0.1:8790');
  assert.equal(backendForHost('http://127.0.0.1:8790', 'bluetooth', cloud, true, true), cloud);
  assert.equal(backendForHost('https://own.test', 'bluetooth', cloud, true), 'https://own.test');
  const preset = { gateway: cloud, token: 'test-only-bundled-device-code-32-characters' };
  assert.equal(accessForGateway(cloud, null, preset), preset.token);
  assert.equal(accessForGateway(cloud, { backend: cloud, token: '' }, preset), preset.token);
  assert.equal(accessForGateway(cloud + '/', null, preset), preset.token);
});
test('预置访问码只发往匹配的网关路径，手动配置优先，不携带到其他地址', () => {
  const preset = { gateway: 'https://cloud.test/wenquan', token: 'test-only-bundled-device-code-32-characters' };
  assert.equal(accessForGateway(preset.gateway, { backend: preset.gateway, token: 'manual-device-code' }, preset), 'manual-device-code');
  for (const backend of ['https://own.test', 'https://cloud.test/other', 'http://127.0.0.1:8787']) {
    assert.equal(accessForGateway(backend, { backend: preset.gateway, token: 'manual-device-code' }, preset), '');
  }
});
test('公网 HTTP 必须有访问码；预检可通过但不能越过鉴权，静态文件可关闭', async t => {
  const token = 'test-only-gateway-code-32-characters';
  assert.throws(() => gatewayAuthorizer('short'), /32/);
  const server = createService({ GATEWAY_TOKEN: token, ALLOW_TOKEN_ORIGINS: 'true', SERVE_WEB: 'false' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/api/health','/api/analyze','/api/transcribe','/api/identify-speakers','/api/summarize']) {
    const response = await fetch(base + path, { method: path === '/api/health' ? 'GET' : 'POST', headers: { Origin: 'https://mobile.webview.test' } });
    assert.equal(response.status, 401); assert.doesNotMatch(await response.text(), new RegExp(token));
  }
  const preflight = await fetch(base + '/api/health', { method: 'OPTIONS', headers: { Origin: 'https://mobile.webview.test', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(preflight.status, 204); assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  const allowed = await fetch(base + '/api/health', { headers: { Origin: 'https://mobile.webview.test', Authorization: `Bearer ${token}` } });
  assert.equal(allowed.status, 200); assert.equal((await allowed.json()).version, '0.5.0');
  assert.equal((await fetch(base + '/config.js')).status, 404);
});
test('ASR 在首包鉴权后才打开上游，访问码不在 WebSocket URL 中', async t => {
  const server = http.createServer(); let opened = 0;
  const token = 'test-only-gateway-code-32-characters';
  attachAsrSocket(server, { key: 'synthetic-key' }, () => true, { authorize: gatewayAuthorizer(token), openStream: (_c, _a, callbacks) => {
    opened++; queueMicrotask(callbacks.onReady); return { cancel() {}, send() {}, stop() { callbacks.onEnd(); } };
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.address().port}/api/asr/stream`;
  const denied = new WebSocket(url); await once(denied, 'open'); denied.send(JSON.stringify({ type: 'start', token: 'wrong' }));
  const [bytes] = await once(denied, 'message'); assert.match(JSON.parse(bytes).error, /访问码/); await once(denied, 'close'); assert.equal(opened, 0);
  const accepted = new WebSocket(url); await once(accepted, 'open'); accepted.send(JSON.stringify({ type: 'start', token }));
  const [ready] = await once(accepted, 'message'); assert.equal(JSON.parse(ready).type, 'ready'); assert.equal(opened, 1); accepted.send(JSON.stringify({ type: 'stop' })); await once(accepted, 'close');
});
