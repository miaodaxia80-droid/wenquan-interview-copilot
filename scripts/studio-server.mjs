import { createService } from '../server/service.mjs';

// Development only: no device credential is needed on the Mac loopback listener.
// Production continues to use service.mjs with its configured authentication.
const server = createService({ ...process.env, GATEWAY_TOKEN: '', ALLOW_LOOPBACK_ORIGINS: 'true' });
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? '8790 端口已有服务，请使用已有实例或先结束它。' : 'Studio 开发服务启动失败。');
  process.exitCode = 1;
});
server.listen(8790, '127.0.0.1', () => console.log('问全 0.4.0 Studio 开发服务：http://127.0.0.1:8790（仅本机，设备访问码留空）'));
