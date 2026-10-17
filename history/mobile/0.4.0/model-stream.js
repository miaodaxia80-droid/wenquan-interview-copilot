// Only the validated result event may enter interview state. Deltas are temporary phone previews.
export function questionPreview(content) {
  const match = /"(?:question|candidates)"\s*:\s*(?:\[\s*)?\{[^{}]*?"text"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(content);
  if (!match) return '';
  try { return JSON.parse(match[1]).slice(0, 100); } catch { return ''; }
}
export async function readModelEvents(response, { signal, onProgress } = {}) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', content = '', result;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const checkAbort = () => { if (signal?.aborted) { const error = new Error('分析已取消。'); error.name = 'AbortError'; throw error; } };
  const line = value => {
    if (!value.trim()) return;
    let event; try { event = JSON.parse(value); } catch { throw new Error('分析数据流格式无效，原话已保留。'); }
    if (event.type === 'error') throw new Error(event.error || '分析中断，原话已保留。');
    if(event.type === 'progress')onProgress?.({phase:'generating',chars:0,preview:'',completed:event.completed,total:event.total});
    else if (event.type === 'reset') { content = ''; onProgress?.({ phase: 'retrying', chars: 0, preview: '' }); }
    else if (event.type === 'delta') {
      if (typeof event.text !== 'string') throw new Error('分析数据流格式无效。');
      content += event.text;
      if (content.length > 128000) throw new Error('分析输出超限，原话已保留。');
      onProgress?.({ phase: 'generating', chars: content.length, preview: questionPreview(content) });
    } else if (event.type === 'start') onProgress?.({ phase: 'connected', model: event.model });
    else if (event.type === 'result') {
      if (result) throw new Error('分析结果重复，未更新记录。');
      result = event;
    }
  };
  try {
    checkAbort();
    while (true) {
      const next = await reader.read(); checkAbort();
      buffer += decoder.decode(next.value, { stream: !next.done });
      if (buffer.length > 256000) throw new Error('分析数据流超限。');
      let at; while ((at = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, at)); buffer = buffer.slice(at + 1); }
      if (next.done) break;
    }
    if (buffer.trim()) line(buffer);
    if (!result) throw new Error('分析连接提前结束，原话已保留，可重试。');
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
