import {createService} from '../server/service.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {newTopic,addSegment,activeQuestion} from '../web/core.js';
import {interviewContext,applyInterview} from '../web/interview.js';
import {summaryContext,validateSummary} from '../web/intelligence.js';
const cloud=process.argv.includes('--cloud');
const connection=cloud?JSON.parse(await readFile(new URL('../.env.connection.json',import.meta.url),'utf8')):null;
const server=cloud?null:createService();if(server)await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=cloud?connection.gateway:`http://127.0.0.1:${server.address().port}`,token=cloud?connection.accessCode:process.env.GATEWAY_TOKEN,headers={'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})};
const report={version:'0.5.0',scope:cloud?'production HTTPS with real model; synthetic text and manually labelled roles':'local HTTP with real configured model; synthetic text and manually labelled roles',physicalDevice:false,at:new Date().toISOString()};
async function call(path,input){const started=Date.now();const res=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(input),signal:AbortSignal.timeout(120000)});if(!res.ok)throw new Error(`HTTP ${res.status}`);const body=await res.json();return {result:body.result,ms:Date.now()-started};}
try {
 const t=newTopic('host'),s=t.sessions[0];s.confirmed=true;
 const first=addSegment(s,'后来我决定先停掉统计图表。');first.role='guest';
 s.questions.push({id:'choice-question',itemId:'choice',text:'决定认真做之后，你做过哪些关键决定？为什么那样选？',informationGoal:'做过的决定及原因',status:'displayed',createdAt:new Date().toISOString(),basisType:'outline'});s.displayedQuestionId='choice-question';
 const host=addSegment(s,'你当时做了哪些取舍，为什么？');host.role='host';
 const guest=addSegment(s,'我停了统计图表，先做保存提示和失败重试。因为用户在报名截止前发现表单没保存，我花两小时帮他补回信息，意识到可靠比功能多更重要。');guest.role='guest';
 const ctx=interviewContext(t,s,guest,[host,guest]);ctx.shortHints=true;const analysis=await call('/api/analyze',ctx);applyInterview(s,guest,analysis.result,ctx,'model');report.analysis=analysis;report.displayed=activeQuestion(s)?.text||null;
 s.endedAt=new Date().toISOString();const summary=await call('/api/summarize',summaryContext(t,s));validateSummary(summary.result,summaryContext(t,s));report.summary=summary;
 report.checks={oldQuestionWithdrawn:s.questions.find(q=>q.id==='choice-question').status!=='displayed',batchProcessed:[host,guest].every(x=>x.analyzedRevision===0),guestClaims:s.claims.length>0&&s.claims.every(c=>c.segmentId===guest.id),shortHints:analysis.result.candidates.every(q=>q.hint && q.hint.length<=28)};
 report.passed=Object.values(report.checks).every(Boolean);if(!report.passed)process.exitCode=1;
} catch(e){report.passed=false;report.error=e.message;process.exitCode=1;} finally {if(server)await new Promise(r=>server.close(r));await writeFile(cloud?'evidence/product-cloud-model-0.5.0.json':'evidence/product-real-model-0.5.0.json',JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({passed:report.passed,checks:report.checks,error:report.error}));
