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

test('已开始访谈且无建议显示低亮度待机，暂停和结束优先清屏',()=>{
  const texts=[];
  const context={...ctx,fillRect(){},fillText(text){texts.push({text,color:this.fillStyle});}};
  const canvas={getContext:()=>context};
  drawHint(canvas,null,{listening:true,chapter:'真实流程'});
  assert.ok(texts.some(x=>x.text==='安静聆听'));assert.ok(texts.some(x=>x.text==='真实流程'));
  assert.ok(texts.every(x=>x.color!=='#fff'));assert.ok(texts.some(x=>x.text==='问全·实时访谈助手'));
  texts.length=0;drawHint(canvas,{text:'有问题'}, {listening:true});
  assert.ok(texts.some(x=>x.text==='有问题'));assert.ok(!texts.some(x=>x.text==='安静聆听'));
  for(const options of [{paused:true},{ended:true}]){texts.length=0;drawHint(canvas,null,{listening:true,...options});assert.equal(texts.length,0);}
});

test('眼镜区分主线建议、追问与等待回答，显示章节位置和下一条主线',()=>{
 const texts=[], context={...ctx,measureText(text){const size=Number(this.font?.match(/(\d+)px/)?.[1]||44);return {width:[...text].reduce((n,c)=>n+(/[\u0000-\u007f]/u.test(c)?size/2:size),0)};},fillRect(){},fillText(text){texts.push(text);}},canvas={getContext:()=>context};
 const q={text:'能介绍你们的项目吗？',source:'outline',guideKind:'main'};
 drawHint(canvas,q,{chapter:'项目与演示',progress:'1/5',nextChapter:'痛点与起因'});
 assert.ok(texts.includes('主线建议'));assert.ok(texts.includes('1/5 · 项目与演示'));assert.ok(texts.includes('接下来可聊：痛点与起因'));assert.ok(texts.includes('建议 · 自由选择'));
 texts.length=0;drawHint(canvas,q,{waiting:true});assert.ok(texts.includes('等待回答'));assert.ok(texts.includes('先听嘉宾回答，再决定是否追问'));
 texts.length=0;drawHint(canvas,{...q,source:'model',type:'deepen'});assert.ok(texts.includes('追问建议'));
 texts.length=0;drawHint(canvas,{...q,guideKind:'closing'});assert.ok(texts.includes('收尾建议'));
});
