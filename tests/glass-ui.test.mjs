import test from 'node:test';
import assert from 'node:assert/strict';
import { hintLines, drawHint } from '../web/glass-ui.js';

const ctx = { measureText: text => ({width:[...text].reduce((n,c)=>n+(/[\u0000-\u007f]/u.test(c)?22:44),0)}) };
test('眼镜短问句完整保留，28 字三行内且不把标点挤到行首', () => {
  for (const text of ['社团当时遇到什么麻烦？','第一次发现用户的需求与最初设想不同时，你做了什么？','后来，你为什么选择自己继续？','从 Demo 到落地，最难的一步是什么？']) {
    const lines = hintLines(ctx, text);
    assert.equal(lines.join(''), text);
    assert.ok(lines.length <= 3);
    for (const line of lines) { assert.ok(ctx.measureText(line).width<=504); assert.doesNotMatch(line,/^[，。？！、；：]/u); }
  }
  assert.ok(hintLines(ctx,'从 Demo 到落地，最难的一步是什么？').some(line=>line.includes('Demo')));
});
test('暂停、结束和无建议只绘制黑底', () => {
  for (const [q,options] of [[{text:'问题'}, {paused:true}],[{text:'问题'}, {ended:true}],[null,{}],[{text:''},{}]]) {
    const calls = [];
    const canvas={ getContext:()=>({fillRect:(...args)=>calls.push(args),fillText:()=>assert.fail('安静状态不应绘制文字')}) };
    drawHint(canvas,q,options);
    assert.deepEqual(calls,[[0,0,600,350]]);
  }
});
