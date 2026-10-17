import { writeFile } from 'node:fs/promises';
import { ANALYSIS_INSTRUCTION } from '../server/model.mjs';
import { newTopic, addSegment, contextFor, validateAnalysis } from '../web/core.js';
const cases = [
 ['fde','FDE例外','普通咨询由值班客服接手。投诉工单会转交客服主管审核，但如果主管一直不回复，我们现在没有统一办法。'],
 ['research','报名障碍','上周我填报名表，到手机验证那一页就退出了。不是不想报名，是验证码试了三次都没收到，也不知道能找谁帮忙。'],
 ['fde','权限与未来','目前不允许 AI 直接修改工单，只能提供分派建议。以后希望把简单咨询自动关闭，但还没有批准上线。'],
 ['research','仅提问','你上次报名遇到什么困难？是验证码收不到吗？']
];
const models = [
 {name:process.env.MODEL_NAME,base:process.env.MODEL_BASE_URL,key:process.env.MODEL_API_KEY},
 ...(process.env.BENCH_EXTRA ? ['glm-5.3-flash','deepseek-v4.1-flash'] : ['doubao-seed-2.0-mini','doubao-seed-2.1-lite']).map(name=>({name,base:'https://ark.cn-beijing.volces.com/api/plan/v3',key:process.env.VOLC_ASR_API_KEY,thinking:{type:'disabled'}}))
];
const report={testedAt:new Date().toISOString(),syntheticInput:true,results:[]};
for(const m of models.filter(m => !(process.env.BENCH_PLAN_ONLY || process.env.BENCH_EXTRA) || m.thinking).filter(m=>!process.env.BENCH_FAST_ONLY || m.name!=='doubao-seed-2.1-lite')) for(const [template,label,text] of cases) {
 const topic=newTopic(template),session=topic.sessions[0]; const seg=addSegment(session,text,'manual');
 const ctx={...contextFor(topic,session,seg),segmentRevision:seg.revision};
 const started=performance.now(); const r={model:m.name,label,success:false};
 try {
 const res=await fetch(m.base+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+m.key},body:JSON.stringify({model:m.name,messages:[{role:'system',content:ANALYSIS_INSTRUCTION},{role:'user',content:JSON.stringify(ctx)}],stream:true,temperature:0.2,max_tokens:2500,response_format:{type:'json_object'},...(m.thinking?{thinking:m.thinking}:{})}),signal:AbortSignal.timeout(45000)});
 if(!res.ok)throw new Error('HTTP '+res.status);
 let buffer='',content='',finish;const decoder=new TextDecoder();
 for await(const bytes of res.body) {buffer+=decoder.decode(bytes,{stream:true});let p;while((p=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,p).trim();buffer=buffer.slice(p+1);if(!line.startsWith('data:')||line.slice(5).trim()==='[DONE]')continue;const chunk=JSON.parse(line.slice(5));const c=chunk.choices?.[0]; if(c?.delta?.content){r.firstContentMs??=Math.round(performance.now()-started);content+=c.delta.content;}if(c?.finish_reason)finish=c.finish_reason;}}
 if(finish!=='stop')throw new Error('finish '+finish);
 const raw=JSON.parse(content); const validated=validateAnalysis(raw,ctx);r.success=true;r.semanticChecks = label === '权限与未来' ? {futureNotStated:validated.claims.filter(c=>c.kind==='future').every(c=>c.status!=='stated'),explicitDenial:raw.claims.some(c=>c.kind==='denial'),noRedundantQuestion:validated.question===null||validated.question.itemId!=='boundary'} : label === '仅提问' ? {noClaims:raw.claims.length===0} : {};r.rawResult=raw;r.result=validated;r.outputChars=content.length;
 }catch(e){r.error=e.message.replaceAll(m.key||'UNSET','[redacted]');}
 r.totalMs=Math.round(performance.now()-started);report.results.push(r);console.log(JSON.stringify({...r,result:undefined,rawResult:undefined}));
 await writeFile(new URL(`../evidence/model-benchmark-0.2.5${process.env.BENCH_EXTRA ? '-extra' : process.env.BENCH_FAST_ONLY ? '-final' : process.env.BENCH_PLAN_ONLY ? '-tuned' : ''}.json`,import.meta.url),JSON.stringify(report,null,2)+'\n');
}
