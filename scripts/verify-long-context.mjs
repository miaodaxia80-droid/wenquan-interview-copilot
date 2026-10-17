import { analyze } from '../server/model.mjs';
import { newTopic, addSegment, contextFor, applyAnalysis } from '../web/core.js';
import { writeFile } from 'node:fs/promises';
const topic=newTopic('fde'),session=topic.sessions[0];session.confirmed=true;
const previous=addSegment(session,'第一版先给分派建议，由值班同事确认。投诉件找主管，主管暂时联系不上时，由值班经理处理。','manual');
const previousContext={...contextFor(topic,session,previous),segmentRevision:previous.revision};
applyAnalysis(session,previous,{claims:[{itemId:'rules',text:'主管联系不上由值班经理处理',kind:'current',status:'stated',segmentId:previous.id,quote:'主管暂时联系不上时，由值班经理处理。'}],question:null,actions:[]},previousContext,'model');
for(let i=0;i<8;i++)addSegment(session,'这是不相关的合成背景对话，请保留原始记录。','manual');
const cases=['【合成访谈测试】投诉件转给主管审核。如果主管超过半小时不回复，我们目前没有统一的兜底方式。','【合成访谈测试】判断工单时需要先看客户资料，但具体由谁维护我还得再确认。'];
const report={at:new Date().toISOString(),syntheticInput:true,model:process.env.MODEL_NAME,results:[]};
for(const text of cases){const seg=addSegment(session,text,'manual'),context={...contextFor(topic,session,seg),segmentRevision:seg.revision};const started=performance.now(),r={retries:0};try{r.result=await analyze(context,{base:process.env.MODEL_BASE_URL,key:process.env.MODEL_API_KEY,model:process.env.MODEL_NAME,stream:true,thinking:'disabled',repair:true},{onRetry:()=>r.retries++});applyAnalysis(session,seg,r.result,context,'model');r.success=true;}catch(e){r.success=false;r.error=e.message;}r.totalMs=Math.round(performance.now()-started);report.results.push(r);}
await writeFile(new URL(`../evidence/long-context-${process.env.MODEL_NAME}-0.2.5.json`,import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(report.results.some(r=>!r.success))process.exitCode=1;
