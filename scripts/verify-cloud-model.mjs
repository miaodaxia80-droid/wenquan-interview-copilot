import { readFile, writeFile } from 'node:fs/promises';
import { readModelEvents } from '../web/model-stream.js';
import { newTopic, addSegment, contextFor, applyAnalysis } from '../web/core.js';
const connection=JSON.parse(await readFile(new URL('../.env.connection.json',import.meta.url),'utf8'));
const base=connection.gateway,headers={Authorization:'Bearer '+connection.accessCode,'Content-Type':'application/json',Origin:'https://phone.wenquan.test'};
const report={at:new Date().toISOString(),syntheticInput:true,physicalPhoneTested:false,results:[]};
report.anonymousStatus=(await fetch(base+'/api/health')).status;
if(report.anonymousStatus!==401)throw new Error('匿名调用未按预期返回401');
report.health=await (await fetch(base+'/api/health',{headers})).json();
if(report.health.model.name!=='deepseek-v4.1-flash'||!report.health.model.streaming)throw new Error('部署的模型或流式配置不匹配');
for(const text of ['普通咨询由值班客服接手。投诉工单会转交客服主管审核，但如果主管一直不回复，我们现在没有统一办法。','目前不允许 AI 直接修改工单，只能提供分派建议。以后希望把简单咨询自动关闭，但还没有批准上线。']) {
 const topic=newTopic('fde'),session=topic.sessions[0];session.confirmed=true; const seg=addSegment(session,text,'manual');
 const context={...contextFor(topic,session,seg),segmentRevision:seg.revision},started=performance.now(),r={success:false,deltas:0,resets:0};
 const response=await fetch(base+'/api/analyze',{method:'POST',headers:{...headers,Accept:'application/x-ndjson'},body:JSON.stringify(context),signal:AbortSignal.timeout(45000)});
 r.headersMs=Math.round(performance.now()-started);if(!response.ok)throw new Error('HTTP '+response.status);
 const value=await readModelEvents(response,{onProgress:p=>{if(p.phase==='retrying')r.resets++;if(p.phase==='generating'){r.firstContentMs??=Math.round(performance.now()-started);r.deltas++;}if(p.preview)r.questionPreviewMs??=Math.round(performance.now()-started);}});
 applyAnalysis(session,seg,value.result,context,'model');r.success=true;r.totalMs=Math.round(performance.now()-started);r.result=value.result;report.results.push(r);
}
const started=performance.now();
const response=await fetch(base+'/api/checklist',{method:'POST',headers:{...headers,Accept:'application/x-ndjson'},body:JSON.stringify({goal:'了解用户在填写报名表时放弃的原因',role:'体验用户'}),signal:AbortSignal.timeout(45000)});
const list=await readModelEvents(response);report.checklist={success:list.items?.length>0,count:list.items?.length,elapsedMs:Math.round(performance.now()-started)};
const t=newTopic('fde'),s=t.sessions[0],seg=addSegment(s,'目前不允许 AI 修改工单，只能提供建议。','manual'),ctx={...contextFor(t,s,seg),segmentRevision:seg.revision};
const legacy=await fetch(base+'/api/analyze',{method:'POST',headers,body:JSON.stringify(ctx),signal:AbortSignal.timeout(45000)});
const legacyJson=await legacy.json();if(!legacy.ok)throw new Error('旧客户端接口失败');applyAnalysis(s,seg,legacyJson.result,ctx,'model');report.legacyJsonCompatible=true;
report.otherSiteStatus=(await fetch('https://cx.kevinxu.cn/')).status;
await writeFile(new URL('../evidence/cloud-model-stream-0.2.5.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,results:report.results.map(r=>({...r,result:undefined}))},null,2));
