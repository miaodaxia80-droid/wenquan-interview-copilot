// 中间结果覆盖预览；稳定分句按时间范围去重，识别修订显式返回。
export class TranscriptStream {
  constructor() { this.stable = new Map(); }
  update(result, final = false) {
    const r = Array.isArray(result) ? result[0] : result;
    if (!r || typeof r !== 'object') return { partial: '', additions: [], corrections: [] };
    const additions = [], corrections = [], pending = [];
    const utterances = Array.isArray(r.utterances) ? r.utterances : [];
    for (const [index, u] of utterances.entries()) {
      if (typeof u.text !== 'string' || !u.text.trim()) continue;
      const text = u.text.trim();
      if (!u.definite && !final) { pending.push(text); continue; }
      const timed = Number.isFinite(u.start_time) && Number.isFinite(u.end_time) && u.start_time >= 0 && u.end_time >= u.start_time;
      // 套餐服务可能以 -1 表示未提供时间；已 definite 的句子仍实时入库。
      if (!timed && [...this.stable.values()].includes(text)) continue;
      const key = timed ? `${u.start_time}:${u.end_time}` : `untimed:${index}`;
      const prior = this.stable.get(key);
      if (prior === text) continue;
      this.stable.set(key, text);
      (prior === undefined ? additions : corrections).push({ key, text, ...(timed ? { startMs: u.start_time, endMs: u.end_time } : { timingUnavailable: true }) });
    }
    // 只有最终包、且完全没有分句信息时，才把全文作为一个稳定片段。
    if (final && !utterances.length && !this.stable.size && typeof r.text === 'string' && r.text.trim()) {
      const text = r.text.trim(); this.stable.set('final', text); additions.push({ key: 'final', text });
    }
    return { partial: pending.join('') || (!utterances.length && !final ? (r.text || '') : ''), additions, corrections };
  }
}
