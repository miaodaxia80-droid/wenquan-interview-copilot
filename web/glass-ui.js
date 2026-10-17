import { compactHint } from './productivity.js';

const FONT = '"PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
const CLOSE = /^[，。？！、；：,.!?;:）】》」』…]/u;
const OPEN = /[（【《「『]$/u;

// Short prompts are balanced across the fewest lines that fit. Keep punctuation
// with its phrase, and prefer spaces over breaking an English word.
export function hintLines(ctx, text, width = 504) {
  const chars = [...text.replace(/\s+/gu, ' ').trim()];
  if (!chars.length) return [];
  const boundaries = new Set([0]);
  if (typeof Intl.Segmenter === 'function') {
    let offset = 0;
    for (const part of new Intl.Segmenter('zh', { granularity: 'word' }).segment(chars.join(''))) {
      offset += [...part.segment].length; boundaries.add(offset);
    }
  }
  const memo = new Map();
  function solve(start, count) {
    if (start === chars.length) return { lines: [], cost: count ? Infinity : 0 };
    if (!count) return { lines: [], cost: Infinity };
    const key = `${start}:${count}`;
    if (memo.has(key)) return memo.get(key);
    let best = { lines: [], cost: Infinity };
    for (let end = start + 1; end <= chars.length; end++) {
      const line = chars.slice(start, end).join('').trim();
      const measured = ctx.measureText(line).width;
      if (measured > width) break;
      const rest = solve(end, count - 1);
      const wordBreak = /[a-z0-9]$/iu.test(line) && /^[a-z0-9]/iu.test(chars[end] || '');
      const penalty = (CLOSE.test(chars[end] || '') || OPEN.test(line) ? width ** 2 * 4 : 0)
        + (wordBreak ? width ** 2 : 0)
        + (boundaries.size > 1 && !boundaries.has(end) ? width ** 2 * .3 : 0);
      const cost = (width - measured) ** 2 + penalty + rest.cost;
      if (cost < best.cost) best = { lines: [line, ...rest.lines], cost };
    }
    memo.set(key, best);
    return best;
  }
  for (let count = 1; count <= chars.length; count++) {
    const result = solve(0, count);
    if (Number.isFinite(result.cost)) return result.lines;
  }
  return [chars.join('')];
}

function ellipsize(ctx, text, width) {
  let value = String(text || '').replace(/\s+/gu, ' ').trim();
  if (ctx.measureText(value).width <= width) return value;
  const chars = [...value];
  while (chars.length && ctx.measureText(chars.join('') + '…').width > width) chars.pop();
  return chars.join('') + '…';
}

export function drawHint(canvas, question, { paused = false, ended = false, listening = false, demo = false, chapter = '' } = {}) {
  canvas.width = 600; canvas.height = 350;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 600, 350);
  if (paused || ended) return;
  const text = compactHint(question).trim();
  if (!text && !listening) return;

  // These values land exactly on GRAY_4 levels; the glasses choose the hue.
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#bbb'; ctx.fillRect(32, 36, 3, 19);
  ctx.font = `500 22px ${FONT}`;
  const label = text ? ({ deepen: '深入追问', supplement: '补充细节', transition: '自然转场' }[question.type] || '可以追问') : '访谈进行中';
  ctx.fillText(label, 48, 54);
  ctx.font = `400 20px ${FONT}`; ctx.fillStyle = '#888';
  const context = ellipsize(ctx, chapter, 300);
  ctx.textAlign = 'right'; ctx.fillText(context, 552, 54); ctx.textAlign = 'left';

  if (text) {
    ctx.font = `500 44px ${FONT}`;
    let lines = hintLines(ctx, text);
    // Defensive fallback for unusual font metrics, without clipping any text.
    for (let size = 42; lines.length > 3 && size >= 28; size -= 2) {
      ctx.font = `500 ${size}px ${FONT}`; lines = hintLines(ctx, text);
    }
    const firstBaseline = 184 - (lines.length - 1) * 28;
    ctx.fillStyle = '#fff';
    lines.forEach((line, i) => ctx.fillText(line, 48, firstBaseline + i * 56));
  } else {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#555'; ctx.fillRect(276, 115, 48, 2);
    ctx.font = `400 36px ${FONT}`; ctx.fillStyle = '#999'; ctx.fillText('安静聆听', 300, 178);
    ctx.font = `400 21px ${FONT}`; ctx.fillStyle = '#777'; ctx.fillText('有新的追问，会在这里提醒你', 300, 222);
    ctx.textAlign = 'left';
  }

  ctx.fillStyle = '#555'; ctx.fillRect(48, 291, 28, 2);
  ctx.font = `500 20px ${FONT}`; ctx.fillStyle = '#888'; ctx.fillText('问全·实时访谈助手', 88, 299);
  if (demo) { ctx.textAlign = 'right'; ctx.fillText('离线演示', 552, 299); }
}
