// Product helpers shared by UI, exports and regression tests.
export function parseOutline(value) {
  const rows = String(value || '').split(/\r?\n/).map(x => x.replace(/^\s*(?:#{1,6}\s*|[-*•]\s*|\d+[.)、]\s*)/, '').trim()).filter(Boolean);
  if (!rows.length || rows.length > 30 || rows.some(x => x.length > 300)) throw new Error('请粘贴 1–30 行提纲，每行不超过 300 字。每行会成为一条可编辑主线。');
  return rows.map(row => ({label: row.slice(0, 100), question: row, preparedQuestions: '', priority: 1}));
}
export function sourcePosition(session, id) {
  const seg = session.segments.find(x => x.id === id), asr = seg?.asr;
  if (!asr || !Number.isFinite(asr.startMs) || !Number.isFinite(asr.endMs) || asr.timingUnavailable) return '文字片段 · 无音频时间';
  const streams = [...new Set(session.segments.filter(x => x.asr).map(x => x.asr.streamId || x.asr.key?.split(':')[0] || 'legacy'))];
  const stream = asr.streamId || asr.key?.split(':')[0] || 'legacy';
  const time = ms => { const seconds = Math.floor(Math.max(0, ms) / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,'0')}`; };
  return `采集段 ${streams.indexOf(stream)+1} · ${time(asr.startMs)}–${time(asr.endMs)}`;
}
export function compactHint(q) {
  if (!q) return '';
  const value = q.hint || q.text;
  return [...value].length <= 28 ? value : [...value].slice(0, 27).join('') + '…';
}
export function materialMarkdown(topic, s) {
  const report = s.interviewSummary, lines = [`# ${topic.title} · 素材索引`, '', 'AI 整理草案，嘉宾自述尚未经事实核实。采集段时间不等于外部视频时间码。', '', `目标：${s.goal}`, '', '## 关键内容', ''];
  for (const p of report?.overview || []) {
    lines.push(`- ${p.text}`);
    for (const ref of p.sources) lines.push(`  > ${ref.quote}`, `  来源：${sourcePosition(s, ref.segmentId)} · ${ref.segmentId}`);
  }
  if (!report) lines.push('尚未生成归纳，请先结束并整理；完整原话仍可另行导出。');
  for (const item of s.items) lines.push('', `## ${item.label}`, '', s.chapterSummaries?.[item.id] || '尚未整理', ...(report?.chapters.find(c=>c.itemId===item.id)?.points || []).flatMap(p=>p.sources.map(ref=>`- ${sourcePosition(s,ref.segmentId)}：「${ref.quote}」（${ref.segmentId}）`)));
  lines.push('', '## 仍需补问', '', ...(report?.followUps || []).map(q=>`- ${q.text}`));
  return lines.join('\n');
}
