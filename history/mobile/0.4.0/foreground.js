import { requestDeadline, abortable } from './platform.js';
// 原生文件选择器收起后，宿主可能晚一拍恢复前台；仅重试这一种暂态拒绝。
export async function readSelectedFile(gm, fileId, { signal, timeoutMs = 8000, intervalMs = 150 } = {}) {
  return runInForeground(gm, () => gm.files.openRead(fileId, { signal }), { signal, timeoutMs, intervalMs });
}
export async function runInForeground(gm, operation, { signal, timeoutMs = 15000, intervalMs = 150 } = {}) {
  const deadline = requestDeadline(signal, timeoutMs, '宿主尚未恢复前台或未响应，请返回问全后重试。');
  try { return await abortable(() => foregroundOperation(gm, operation, { signal: deadline.signal, timeoutMs, intervalMs }), deadline.signal); }
  finally { deadline.dispose(); }
}
async function foregroundOperation(gm, operation, { signal, timeoutMs, intervalMs }) {
  const until = Date.now() + timeoutMs;
  while (true) {
    if (signal.aborted) throw signal.reason || new Error('操作已取消。');
    const state = await abortable(() => gm.runtime.getLifecycleState(), signal);
    if (state.state === 'running') {
      try { return await abortable(operation, signal); }
      catch (error) { if (!String(error.message).includes('NOT_FOREGROUND')) throw error; }
    }
    if (Date.now() >= until) throw new Error('宿主尚未恢复前台，请返回问全后重试。');
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, intervalMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}
