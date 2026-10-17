export async function upstreamFailure(response, label, secrets = []) {
  let body;
  try { body = await response.json(); } catch { /* 上游可返回非 JSON 错误页。 */ }
  let reason = body?.error?.message || body?.message || body?.msg || '';
  if (typeof reason !== 'string') reason = '';
  for (const secret of secrets) if (secret) reason = reason.replaceAll(secret, '[已隐藏]');
  reason = reason.replace(/(?:pk|sk)-[A-Za-z0-9_-]{8,}/g, '[已隐藏]').replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').replace(/[\r\n]/g, ' ').slice(0, 180);
  return Object.assign(new Error(`${label}返回 ${response.status}${reason ? `：${reason}` : ''}。`), { status: 502 });
}
