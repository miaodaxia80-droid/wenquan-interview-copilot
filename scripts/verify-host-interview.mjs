import { createService } from '../server/service.mjs';
import { newTopic, addSegment, contextFor, applyAnalysis, activeQuestion } from '../web/core.js';
import { readModelEvents } from '../web/model-stream.js';
import { writeFile } from 'node:fs/promises';
if (!process.env.MODEL_API_KEY) throw new Error('未配置服务端模型。');
const server=createService();
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const topic=newTopic('host'), s=topic.sessions[0];s.confirmed=true;
const report={softwareVersion:'0.3.0',testedAt:new Date().toISOString(),inputSource:'synthetic labeled text; real model via local HTTP/NDJSON',model:process.env.MODEL_NAME,turns:[],checks:{}};
const steps=[
 ['guest','当时工作挺稳定的，但我总想试试自己的东西。'],
 ['host',()=>activeQuestion(s)?.text || '是什么具体经历让你决定真的开始？'],
 ['guest','具体是朋友请我帮忙做个小工具，做完以后，有几个陌生人也愿意用，所以我决定认真做下去。'],
 ['guest','后来我决定先不辞职，因为还需要稳定收入。下班后每天花两个小时做项目。'],
 ['host','如果你当时已经融资一百万，那你就能辞职了吧？我只是提出一个假设。'],
 ['unknown','我辞职了，还拿到了一百万。'],
];
try {
 for(const [role,input] of steps){const text=typeof input==='function'?input():input;const seg=addSegment(s,text,'manual');seg.role=role;const context=contextFor(topic,s,seg),started=Date.now();let progress=0;const response=await fetch(`http://127.0.0.1:${server.address().port}/api/analyze`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/x-ndjson',...(process.env.GATEWAY_TOKEN?{Authorization:`Bearer ${process.env.GATEWAY_TOKEN}`}:{})},body:JSON.stringify(context),signal:AbortSignal.timeout(90000)});
 if(!response.ok) throw new Error(`HTTP ${response.status}`);
 const wirePromise=response.clone().text(); let event; try { event=await readModelEvents(response,{onProgress:()=>progress++}); } catch(error) { const events=(await wirePromise).trim().split('\n').map(line=>JSON.parse(line)); const reset=events.map(e=>e.type).lastIndexOf('reset'); const draft=events.slice(reset+1).filter(e=>e.type==='delta').map(e=>e.text).join(''); try { const raw=JSON.parse(draft); report.rejectedDraft={fields:Object.keys(raw),arraySizes:Object.fromEntries(Object.entries(raw).filter(([k,v])=>Array.isArray(v)).map(([k,v])=>[k,v.length])),raw}; } catch {} throw error; } const {result}=event;applyAnalysis(s,seg,result,context,'model');
 report.turns.push({role,text,elapsedMs:Date.now()-started,progressEvents:progress,result,displayed:activeQuestion(s)?.text || null,candidateCount:s.questions.filter(q=>['candidate','displayed'].includes(q.status)).length});
 console.log(`第 ${report.turns.length} 轮 ${role}：协议及引用校验通过，${result.candidates.length} 个生成候选，${result.responses.length} 个回应。`);
 }
 report.checks={allResultsValidated:true,noHostOrUnknownClaims:report.turns.filter(t=>t.role!=='guest').every(t=>!t.result.claims.length),hostQuestionRecognized:report.turns[1].result.hostQuestions.length>0,responseAssociated:report.turns[2].result.responses.length>0,earlyChapterContent:s.claims.some(c=>c.itemId==='choice'),candidateLimit:report.turns.every(t=>t.candidateCount<=3),rolesAreLabeledNotDiarization:true};
 report.passed=Object.values(report.checks).every(Boolean);
 if(!report.passed) process.exitCode=1;
} catch(error){report.error=error.message;report.passed=false;process.exitCode=1;}
finally{await new Promise(r=>server.close(r));await writeFile(new URL('../evidence/host-interview-live-model-0.3.0.json',import.meta.url),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({passed:report.passed,checks:report.checks,error:report.error}));
