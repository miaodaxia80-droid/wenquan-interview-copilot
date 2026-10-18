import test from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, newTopic, newSession, addSegment, contextFor, applyAnalysis } from '../web/core.js';
import { validateContext } from '../server/model.mjs';
import { hostPrepare, hostLive } from '../web/interview-ui.js';
import { ensureInterviewSuggestion } from '../web/interview.js';
const templates=Object.entries(TEMPLATES).filter(([,t])=>t.analysisVersion===2);
test('六个实用模板自带目标、时长、主线和预设问题，准备页可编辑',()=>{
 assert.equal(templates.length,6);
 for(const [key,t] of templates){
  const topic=newTopic(key),s=topic.sessions[0];
  assert.equal(s.analysisVersion,2);assert.equal(s.role,'guest');assert.ok(key==='aidol'?s.plannedMinutes===7:s.plannedMinutes>=20);
  assert.ok(s.goal.length>10);assert.equal(s.currentChapterId,s.items[0].id);
  assert.equal(new Set(s.items.map(i=>i.id)).size,s.items.length);
  assert.ok(s.items.every(i=>i.question&&i.preparedQuestions&&i.priority>=1&&i.priority<=3));
  const html=hostPrepare(topic,s,{progress:'',service:''});assert.match(html,/name="plannedMinutes"/);assert.match(html,/开始前检查/);assert.match(html,/检测开始条件/);assert.ok(html.includes(t.title));
 }
});
test('会中建议明确来源，主线推进和保存状态有可见反馈',()=>{
 const topic=newTopic('aidol'),s=topic.sessions[0];s.confirmed=true;ensureInterviewSuggestion(s);
 const html=hostLive(topic,s,{capture:'',progress:'',saveStatus:'<div id="save-status">已保存 · 刚刚</div>',timing:'<span>第 1 / 5 条主线</span>'});
 assert.match(html,/主线建议/);assert.match(html,/按已确认的访谈主线推进/);assert.match(html,/已保存 · 刚刚/);assert.match(html,/第 1 \/ 5 条主线/);
});
test('每个新模板可经过既有 v2 模型协议处理原话和候选',()=>{
 for(const [key] of templates){
  const topic=newTopic(key),s=topic.sessions[0];s.confirmed=true;
  const seg=addSegment(s,'最近一次我花了很长时间核对资料。');seg.role='guest';
  const ctx=contextFor(topic,s,seg);validateContext(ctx);
  applyAnalysis(s,seg,{analysisVersion:2,candidates:[{itemId:s.items[0].id,text:'当时具体发生了什么？',hint:'当时具体发生了什么？',informationGoal:'具体经过',type:'deepen',basisType:'transcript',segmentId:seg.id,quote:seg.text,gap:'需要具体经过'}],claims:[],responses:[],hostQuestions:[]},ctx,'model');
  assert.equal(s.questions.length,1);assert.equal(s.questions[0].itemId,s.items[0].id);
 }
});
test('修改一份模板访谈不会污染其他新记录，续接保留调整后的提纲',()=>{
 const a=newTopic('requirements'),b=newTopic('requirements'),s=a.sessions[0];
 s.items[0].question='我修改过的具体问题';s.items[0].preparedQuestions='自己的补充';s.items.reverse();
 assert.notEqual(b.sessions[0].items.at(-1).question,s.items.at(-1).question);
 const next=newSession('requirements',a.id,s.items);assert.equal(next.analysisVersion,2);assert.equal(next.currentChapterId,s.items[0].id);assert.deepEqual(next.items,s.items);
 next.items[0].question='下一场修改';assert.notEqual(next.items[0].question,s.items[0].question);
 assert.equal(newTopic('fde').sessions[0].analysisVersion,undefined);assert.equal(newTopic('research').sessions[0].analysisVersion,undefined);
});
