import test from 'node:test';
import assert from 'node:assert/strict';
import { newTopic, addSegment, activeQuestion, contextFor, applyAnalysis } from '../web/core.js';
import { ensureInterviewSuggestion, interviewDisplay, questionFeedback, setChapter, availableQuestions, addHostQuestion } from '../web/interview.js';
const setup = () => { const topic = newTopic('aidol'), s = topic.sessions[0]; s.confirmed = true; return {topic,s}; };
const empty = () => ({analysisVersion:2,claims:[],responses:[],hostQuestions:[],candidates:[]});
function answer(x, raw = () => empty()) { const seg = addSegment(x.s,'我给社团做了一个整理活动信息的小工具。'); seg.role='guest'; const ctx=contextFor(x.topic,x.s,seg); applyAnalysis(x.s,seg,raw(seg,ctx),ctx,'model'); return seg; }
test('无语音也显示稳定的第一条主线建议，不调用模型、不伪造已问和章节完成',()=>{
 const {s}=setup(), q=ensureInterviewSuggestion(s), revision=s.revision;
 assert.equal(q.text,s.items[0].question);assert.equal(q.source,'outline');assert.equal(q.status,'displayed');assert.equal(s.segments.length,0);
 for(let n=0;n<3;n++) assert.equal(ensureInterviewSuggestion(s),null);
 assert.equal(s.revision,revision);assert.equal(activeQuestion(s).id,q.id);assert.deepEqual(s.chapterStates,{});
 assert.equal(interviewDisplay(s).progress,'1/5');assert.equal(interviewDisplay(s).nextChapter,s.items[1].label);
});
test('已问时等待回应，原问题留在眼镜显示，不擅自推进或记为已答',()=>{
 const {s}=setup(), q=ensureInterviewSuggestion(s);questionFeedback(s,q.id,'asked');
 assert.equal(ensureInterviewSuggestion(s),null);assert.equal(activeQuestion(s),null);assert.equal(q.status,'asked');
 assert.equal(interviewDisplay(s).question.id,q.id);assert.equal(interviewDisplay(s).waiting,true);
});
test('回答主问题后给下一主线建议，已有一点陈述不等于整章已回答',()=>{
 const x=setup(), q=ensureInterviewSuggestion(x.s);
 answer(x,seg=>({...empty(),claims:[{itemId:q.itemId,text:seg.text,kind:'current',status:'stated',segmentId:seg.id,quote:seg.text}]}));
 assert.equal(activeQuestion(x.s).id,q.id);
 answer(x,seg=>({...empty(),responses:[{questionId:q.id,segmentId:seg.id,quote:seg.text}]}));
 const next=ensureInterviewSuggestion(x.s);assert.equal(next.itemId,'problem');assert.equal(next.status,'displayed');assert.equal(q.status,'answered');assert.deepEqual(x.s.chapterStates,{});
});
test('有原话依据的模型追问优先于静态主线建议，不改变模型题的阅读稳定规则',()=>{
 const x=setup(), outline=ensureInterviewSuggestion(x.s);
 answer(x,seg=>({...empty(),candidates:[{itemId:'project',text:'社团之前怎么整理这些信息？',hint:'社团之前怎么整理这些信息？',type:'deepen',basisType:'transcript',segmentId:seg.id,quote:seg.text,gap:'了解原来的流程',informationGoal:'原流程'}]}));
 assert.equal(outline.status,'superseded');assert.equal(activeQuestion(x.s).source,'model');assert.equal(availableQuestions(x.s).length,1);
 const model=activeQuestion(x.s);answer(x);assert.equal(activeQuestion(x.s).id,model.id);
});
test('略过和稍后按提纲继续建议，但不当成已答；收尾建议只处理一次',()=>{
 const {s}=setup();
 for(const [n,item] of s.items.entries()) { const q=ensureInterviewSuggestion(s);assert.equal(q.itemId,item.id);questionFeedback(s,q.id,n%2?'deferred':'skipped'); }
 const closing=ensureInterviewSuggestion(s);assert.equal(closing.guideKind,'closing');assert.equal(closing.status,'displayed');
 questionFeedback(s,closing.id,'skipped');assert.equal(ensureInterviewSuggestion(s),null);assert.equal(interviewDisplay(s).complete,true);assert.ok(s.questions.every(q=>q.status!=='answered'));assert.equal(s.endedAt,null);
});
test('暂停、结束、未确认、旧版、未处理语音和未分析转写均不生成新建议',()=>{
 for(const mutate of [s=>s.paused=true,s=>s.endedAt=new Date().toISOString(),s=>s.confirmed=false,s=>s.analysisVersion=undefined,s=>s.pendingAsr.push({text:'语音'}),s=>addSegment(s,'等待分析')]) { const {s}=setup();mutate(s);assert.equal(ensureInterviewSuggestion(s),null);assert.equal(s.questions.length,0); }
 const {s}=setup();ensureInterviewSuggestion(s);s.paused=true;assert.equal(interviewDisplay(s).question,null);
});
test('手动调整主线优先，手工关闭的章节不再提示；未问建议可随主线修订更新',()=>{
 const {s}=setup();ensureInterviewSuggestion(s);setChapter(s,'challenge');assert.equal(ensureInterviewSuggestion(s).itemId,'challenge');
 setChapter(s,'challenge',true);assert.notEqual(ensureInterviewSuggestion(s).itemId,'challenge');
});

test('有其他候选时点已问仍等待当前回应；手动切章能继续显示新主线',()=>{
 const {s}=setup(),q=ensureInterviewSuggestion(s);
 s.questions.push({...q,id:'alternative',source:'model',guideKind:undefined,status:'candidate',text:'给谁使用？'});
 questionFeedback(s,q.id,'asked');assert.equal(activeQuestion(s),null);assert.equal(interviewDisplay(s).waiting,true);
 setChapter(s,'problem');assert.equal(ensureInterviewSuggestion(s).itemId,'problem');assert.equal(q.status,'asked');
});
test('长自定义提纲给完整短问句，完整问题保留在手机与上下文',()=>{
 const {s}=setup();s.items[0].question='请用一个最近的实际经历，详细描述你们的项目从输入到输出之间的整个使用过程，以及谁在其中参与和处理例外情况？';
 const q=ensureInterviewSuggestion(s);assert.ok([...q.hint].length<=28);assert.match(q.hint,/？$/);assert.doesNotMatch(q.hint,/…/);assert.equal(q.text,s.items[0].question);
});


test('语音识别到下一章的实际提问时等待该章回应，不越过未答主问题',()=>{
 const x=setup(),first=ensureInterviewSuggestion(x.s);questionFeedback(x.s,first.id,'skipped');const next=ensureInterviewSuggestion(x.s);
 const seg=addSegment(x.s,next.text);seg.role='host';const ctx=contextFor(x.topic,x.s,seg);
 applyAnalysis(x.s,seg,{...empty(),hostQuestions:[{questionId:next.id,itemId:next.itemId,text:seg.text,quote:seg.text,segmentId:seg.id}]},ctx,'model');
 assert.equal(x.s.currentChapterId,next.itemId);assert.equal(next.status,'asked');assert.equal(ensureInterviewSuggestion(x.s),null);assert.equal(interviewDisplay(x.s).question.id,next.id);
});
test('补记实际自拟问题撤下旧建议，保留为待答提醒而非继续生成主线',()=>{
 const {s}=setup(),outline=ensureInterviewSuggestion(s),q=addHostQuestion(s,'你们现在有几位用户？','next');
 assert.equal(outline.status,'superseded');assert.equal(interviewDisplay(s).question.id,q.id);assert.equal(ensureInterviewSuggestion(s),null);assert.equal(s.currentChapterId,'next');
});
