// OpenAI-compatible SSE: tolerate transport/UTF-8/frame boundaries, commit only a finished JSON document.
export async function readModelStream(response, { onDelta, signal } = {}) {
  if (!response.body) throw new Error('模型未返回数据流。');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', content = '', finish = '', done = false;
  const frame = value => {
    const data = value.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    let chunk; try { chunk = JSON.parse(data); } catch { throw new Error('模型流数据格式无效。'); }
    if (chunk.error) throw new Error('模型流中断，请重试；已有记录未变。');
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finish = choice.finish_reason;
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta) {
      content += delta;
      if (content.length > 128000) throw new Error('模型输出超限，未更新记录。');
      onDelta?.(delta);
    }
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      signal?.throwIfAborted();
      buffer += decoder.decode(next.value, { stream: !next.done });
      if (buffer.length > 256000) throw new Error('模型流数据超限。');
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        frame(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length);
      }
      if (next.done) break;
    }
    if (buffer.trim()) frame(buffer);
    if (finish === 'length') throw new Error('模型结果被截断，未更新记录。');
    if (!done || finish !== 'stop') throw new Error('模型流未完整结束，未更新记录。');
    return content;
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
