import test from 'node:test';
import assert from 'node:assert/strict';
import {newTopic,addSegment,activeQuestion} from '../web/core.js';
import {interviewContext,applyInterview,validateInterview,availableQuestions,chapterStatus} from '../web/interview.js';
import {parseOutline,sourcePosition,materialMarkdown,compactHint} from '../web/productivity.js';
import {hostLive,hostPrepare,hostResults} from '../web/interview-ui.js';
import {validateContext} from '../server/model.mjs';
const empty=()=>({analysisVersion:2,claims:[],candidates:[],responses:[],hostQuestions:[]});
const setup=()=>{const t=newTopic('host'),s=t.sessions[0];s.confirmed=true;return {t,s};};
const turn=(s,text,role='guest')=>{const x=addSegment(s,text);x.role=role;return x;};
const candidate=(seg,text='为什么先修保存？')=>({itemId:'choice',text,hint:'为什么先修保存？',informationGoal:'取舍依据',type:'deepen',basisType:'transcript',segmentId:seg.id,quote:seg.text,gap:'缺少判断依据'});
test('同一批次保留每段原话，主持人提问后嘉宾回应可以闭环',()=>{
 const {t,s}=setup(),a=turn(s,'为什么停掉图表？','host'),b=turn(s,'因为用户更在意保存可靠。');
 const ctx=interviewContext(t,s,b,[a,b]);validateContext(ctx);
 applyInterview(s,b,{...empty(),hostQuestions:[{itemId:'choice',text:a.text,quote:a.text,segmentId:a.id,questionId:null}],responses:[{questionId:`host:${a.id}`,segmentId:b.id,quote:b.text}],claims:[{itemId:'choice',text:b.text,quote:b.text,segmentId:b.id,kind:'current',status:'stated'}]},ctx,'model');
 assert.equal(s.questions[0].status,'answered');assert.equal(s.questions[0].askedAfter,1);assert.equal(s.questions[0].response.segmentId,b.id);assert.equal(s.segments.length,2);assert.ok(s.segments.every(x=>x.analyzedRevision===0));
});
test('批次回应不能倒用提问之前的答案，也不能把历史原话作为新增陈述',()=>{
 const {t,s}=setup(),b=turn(s,'因为用户需要。'),a=turn(s,'为什么？','host'),ctx=interviewContext(t,s,a,[b,a]);
 assert.throws(()=>validateInterview({...empty(),hostQuestions:[{itemId:'origin',text:a.text,quote:a.text,segmentId:a.id}],responses:[{questionId:`host:${a.id}`,segmentId:b.id,quote:b.text}]},ctx),/轮次/);
 const c=turn(s,'后来继续修。'),next=interviewContext(t,s,c);
 assert.throws(()=>validateInterview({...empty(),claims:[{itemId:'origin',text:b.text,quote:b.text,segmentId:b.id,kind:'current',status:'stated'}]},next),/依据/);
});
test('过时提示可以撤下而不虚称已回答；同目标换词不会重复推送',()=>{
 const {t,s}=setup(),a=turn(s,'我先修了保存。');applyInterview(s,a,{...empty(),candidates:[candidate(a)]},interviewContext(t,s,a),'model');const q=activeQuestion(s);
 const b=turn(s,'这件事先不展开，聊下一段。');applyInterview(s,b,{...empty(),reviews:[{questionId:q.id,status:'superseded',reason:'嘉宾明确暂不展开'}]},interviewContext(t,s,b),'model');assert.equal(q.status,'superseded');assert.equal(activeQuestion(s),null);
 q.status='answered';const c=turn(s,'后来也一样。');applyInterview(s,c,{...empty(),candidates:[candidate(c,'为什么这样取舍？')]},interviewContext(t,s,c),'model');assert.equal(availableQuestions(s).length,0);
});
test('提前回答与新候选同一响应时，不重新推出同一信息目标',()=>{
 const {t,s}=setup(),a=turn(s,'我先修保存。');applyInterview(s,a,{...empty(),candidates:[candidate(a)]},interviewContext(t,s,a),'model');const q=activeQuestion(s),b=turn(s,'因为用户更需要可靠。');
 applyInterview(s,b,{...empty(),responses:[{questionId:q.id,segmentId:b.id,quote:b.text}],candidates:[candidate(b,'你为什么这样做？')]},interviewContext(t,s,b),'model');assert.equal(q.status,'answered');assert.equal(activeQuestion(s),null);
});
test('提纲粘贴保留全文，拒绝空白、超长与过量，不静默截断问题',()=>{
 assert.deepEqual(parseOutline('1. 为什么开始\n- 做了什么选择').map(x=>x.question),['为什么开始','做了什么选择']);
 for(const value of ['', '字'.repeat(301),Array(31).fill('问题').join('\n')])assert.throws(()=>parseOutline(value));
});
test('素材索引区分录音重启和无时间文本，并保留人工摘要',()=>{
 const {t,s}=setup(),a=turn(s,'第一次。'),b=turn(s,'第二次。'),c=turn(s,'手动文本。');a.asr={streamId:'one',startMs:1000,endMs:2000};b.asr={streamId:'two',startMs:1000,endMs:2500};
 assert.match(sourcePosition(s,a.id),/采集段 1 · 0:01/);assert.match(sourcePosition(s,b.id),/采集段 2 · 0:01/);assert.match(sourcePosition(s,c.id),/无音频时间/);
 s.chapterSummaries={origin:'人工修改的摘要'};s.interviewSummary={overview:[{text:'测试内容',sources:[{segmentId:a.id,quote:a.text}]}],chapters:[],followUps:[]};const md=materialMarkdown(t,s);assert.match(md,/人工修改的摘要/);assert.match(md,/第一次/);assert.doesNotMatch(md,/undefined/);
});
test('会中操作和备选默认折叠，保留既有动作，眼镜短提示有长度上限',()=>{
 const {t,s}=setup(),a=turn(s,'原话');applyInterview(s,a,{...empty(),candidates:[candidate(a),{...candidate(a,'后来有什么变化？'),informationGoal:'结果'}]},interviewContext(t,s,a),'model');
 const html=hostLive(t,s,{capture:'',progress:'',delivery:''});assert.match(html,/<summary>其他问法<\/summary>/);assert.match(html,/data-action="asked"/);assert.match(html,/<summary>查看与调整主线/);assert.equal(compactHint(activeQuestion(s)),'为什么先修保存？');assert.equal([...compactHint({text:'字'.repeat(100)})].length,28);
 assert.match(hostPrepare(t,s,{progress:'',service:''}),/id="outline-paste"/);assert.match(hostResults(t,s),/data-action="download-materials"/);
});

test('会中折叠标签成对，避免浏览器提前关闭整个主线面板',()=>{
 const {t,s}=setup();const html=hostLive(t,s,{capture:'',progress:'',delivery:''});assert.equal((html.match(/<details\b/g)||[]).length,(html.match(/<\/details>/g)||[]).length);
});
