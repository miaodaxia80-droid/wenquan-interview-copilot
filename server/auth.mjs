import { createHash, timingSafeEqual } from 'node:crypto';
const digest = value => createHash('sha256').update(value).digest();
export function gatewayAuthorizer(expected = '') {
  if (!expected) return () => true; // 本机开发；对外监听在启动入口强制要求访问码。
  if (expected.length < 32) throw new Error('网关访问码至少需要 32 个字符。');
  const wanted = digest(expected);
  return value => typeof value === 'string' && value.length <= 256 && timingSafeEqual(wanted, digest(value));
}
