// Android WebView 的版本由系统决定；不用较新的静态 AbortSignal API。
export const last = values => values[values.length - 1];
export const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export function requestDeadline(parent, timeoutMs, message = '请求超时，请重试。') {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason || new Error('操作已取消。'));
  const timer = setTimeout(() => {
    const error = new Error(message); error.name = 'TimeoutError'; controller.abort(error);
  }, timeoutMs);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}
export function abortable(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error('操作已取消。'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('操作已取消。'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
