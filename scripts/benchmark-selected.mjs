import { analyze } from '../server/model.mjs';
import { newTopic, addSegment, contextFor } from '../web/core.js';
import { parseEnv } from 'node:util';
import { questionPreview } from '../web/model-stream.js';
import { readFile, writeFile } from 'node:fs/promises';
const cases = [
 ['fde','FDE例外','普通咨询由值班客服接手。投诉工单会转交客服主管审核，但如果主管一直不回复，我们现在没有统一办法。'],
 ['research','报名障碍','上周我填报名表，到手机验证那一页就退出了。不是不想报名，是验证码试了三次都没收到，也不知道能找谁帮忙。'],
 ['fde','权限与未来','目前不允许 AI 直接修改工单，只能提供分派建议。以后希望把简单咨询自动关闭，但还没有批准上线。'],
 ['research','仅提问','你上次报名遇到什么困难？是验证码收不到吗？']
];
const old = parseEnv(await readFile(new URL('../.env.benchmark-baseline',import.meta.url),'utf8'));
const models = [
 {model:old.MODEL_NAME,base:old.MODEL_BASE_URL,key:old.MODEL_API_KEY,stream:false},
 {model:'deepseek-v4.1-flash',base:'https://ark.cn-beijing.volces.com/api/plan/v3',key:process.env.VOLC_ASR_API_KEY,stream:true,thinking:'disabled',repair:true}
];
const report={testedAt:new Date().toISOString(),syntheticInput:true,baselineMode:'原应用非流式',results:[]};
for(const config of models) for(const [template,label,text] of cases) {
 const topic=newTopic(template),session=topic.sessions[0],seg=addSegment(session,text,'manual');
 const context={...contextFor(topic,session,seg),segmentRevision:seg.revision};
 const started=performance.now(),r={model:config.model,label,retries:0,success:false};
 let content = '';
 try {r.result=await analyze(context,config,{onDelta:delta=>{r.firstContentMs??=Math.round(performance.now()-started);content+=delta;if(questionPreview(content))r.questionPreviewMs??=Math.round(performance.now()-started);},onRetry:()=>{r.retries++;content='';}});r.success=true;}
 catch(e){r.error=e.message.replaceAll(config.key,'[redacted]');}
 r.totalMs=Math.round(performance.now()-started);report.results.push(r);
 console.log(JSON.stringify({...r,result:undefined}));
 await writeFile(new URL('../evidence/selected-model-benchmark-0.2.5.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
}
