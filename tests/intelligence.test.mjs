import test from 'node:test';
import assert from 'node:assert/strict';
import {roleContext,applyRoles,validateRoles,validateSummary} from '../web/intelligence.js';
import {summarize} from '../server/intelligence.mjs';
import {createService} from '../server/service.mjs';
const seg=(id,text,role='unknown',speakerKey=null)=>({id,text,role,speakerKey,revision:0});
const session=()=>({revision:0,segments:[seg('h','我是主持人，今天想了解你的项目。','unknown','stream1:0'),seg('g','我是今天的嘉宾，我没有辞职。','unknown','stream1:1'),seg('g2','以后希望做全职，目前还没有。','unknown','stream1:1'),seg('new','你好。','unknown','stream2:1')]});
const assignment=(id,role,quote,confidence=.98)=>({segmentId:id,role,quote,confidence});
test('自动角色绑定并传播同一声音，跨采集流隔离；不确定角色保留',()=>{
 const s=session(),ctx=roleContext(s);const changed=applyRoles(s,{assignments:[assignment('h','host','我是主持人'),assignment('g','guest','我是今天的嘉宾')]},ctx);
 assert.deepEqual(changed,['h','g','g2']);assert.equal(s.segments[2].role,'guest');assert.equal(s.segments[3].role,'unknown');assert.equal(s.speakerBindingSources['stream1:1'],'auto');
 assert.deepEqual(applyRoles(s,{assignments:[assignment('new','guest','你好',.7)]},roleContext(s)),[]);
});
test('同一声音的冲突判断、人工未知和人工绑定不能被自动覆盖',()=>{
 const s=session();s.segments[1].roleSource='manual';s.speakerBindings={'stream1:0':'guest'};
 applyRoles(s,{assignments:[assignment('h','host','我是主持人'),assignment('g','guest','我是今天的嘉宾'),assignment('g2','host','以后希望')]},roleContext(s));
 assert.ok(s.segments.every(x=>x.role==='unknown'));
});
test('自动角色必须引用原话，忽略模型伪造声音编号，拒绝无效置信值',()=>{
 const ctx=roleContext(session());assert.throws(()=>validateRoles({assignments:[assignment('h','host','我是嘉宾')]},ctx),/依据/);
 assert.throws(()=>validateRoles({assignments:[assignment('h','host','我是主持人',NaN)]},ctx),/依据/);
 assert.equal(validateRoles({assignments:[{...assignment('h','host','我是主持人'),speakerKey:'evil'}]},ctx).assignments[0].speakerKey,'stream1:0');
});
const ctx={topic:'项目',goal:'了解选择',items:[{id:'a',label:'选择',question:'现在做了什么？'},{id:'b',label:'后续',question:'以后准备怎样？'}],questions:[],segments:[seg('h','如果你辞职了呢？','host'),seg('g','我没有辞职。','guest'),seg('u','已经融资。')]};
const report=()=>({overview:[{text:'嘉宾表示没有辞职。',sources:[{segmentId:'g',quote:'我没有辞职。'}]}],chapters:[{itemId:'a',points:[]},{itemId:'b',points:[]}],followUps:[]});
test('归纳只接受嘉宾逐字引用，拒绝主持人、未知角色、假引用及漏章重复章',()=>{
 assert.equal(validateSummary(report(),ctx).overview.length,1);
 for(const ref of [{segmentId:'h',quote:'如果你辞职了呢？'},{segmentId:'u',quote:'已经融资。'},{segmentId:'g',quote:'我辞职了。'}]){const r=report();r.overview[0].sources=[ref];assert.throws(()=>validateSummary(r,ctx),/引文/);}
 const r=report();r.chapters[1].itemId='a';assert.throws(()=>validateSummary(r,ctx),/主线/);r.chapters.pop();assert.throws(()=>validateSummary(r,ctx),/结构/);
});
test('长访谈逐块整理后合并，最终仍引用完整原话并报告覆盖段数',async()=>{
 const input={...ctx,segments:Array.from({length:5},(_,i)=>seg('g'+i,'访谈内容。'.repeat(1600),'guest'))};let calls=0;
 const fetchImpl=async(_url,options)=>{calls++;const payload=JSON.parse(JSON.parse(options.body).messages[1].content);const s=payload.segments[0];const r=report();r.overview[0].sources=[{segmentId:s.id,quote:'访谈内容。'}];return Response.json({choices:[{message:{content:JSON.stringify(r)},finish_reason:'stop'}]});};
 const r=await summarize(input,{key:'test',base:'https://mock.test',model:'test'},{fetchImpl});assert.equal(r.coverage.segments,5);assert.equal(r.coverage.chunks,3);assert.equal(calls,4);assert.equal(r.overview[0].sources[0].segmentId,'g0');
});
test('网关新接口真实路由及NDJSON结果校验，健康声明新功能',async t=>{
 const r=report();const server=createService({MODEL_API_KEY:'test',MODEL_NAME:'test'},async(_url,o)=>{const input=JSON.parse(JSON.parse(o.body).messages[1].content);return Response.json({choices:[{message:{content:JSON.stringify(input.bindings?{assignments:[assignment('h','host','我是主持人')]}:r)}}]});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
 assert.deepEqual((await(await fetch(base+'/api/health')).json()).features,{batchAnalysis:true,automaticRoles:true,interviewSummary:true});
 for(const [path,input] of [['identify-speakers',roleContext(session())],['summarize',ctx]]){const res=await fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/x-ndjson'},body:JSON.stringify(input)});const events=(await res.text()).trim().split('\n').map(JSON.parse);assert.equal(events.at(-1).type,'result');assert.ok(events.at(-1).result);}
});
