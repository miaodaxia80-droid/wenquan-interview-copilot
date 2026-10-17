import {createService} from '../server/service.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {newTopic,addSegment,contextFor,applyAnalysis,activeQuestion} from '../web/core.js';
import {roleContext,applyRoles,summaryContext,validateSummary} from '../web/intelligence.js';
import {readModelEvents} from '../web/model-stream.js';
const cloud=process.argv.includes('--cloud');let server,base,token;
if(cloud){const c=JSON.parse(await readFile(new URL('../.env.connection.json',import.meta.url),'utf8'));base=c.gateway;token=c.accessCode;}else{server=createService();await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;token=process.env.GATEWAY_TOKEN;}
const headers={'Content-Type':'application/json',Accept:'application/x-ndjson',...(token?{Authorization:'Bearer '+token}:{})};
const report={at:new Date().toISOString(),softwareVersion:'0.4.0',scope:cloud?'production HTTPS + real model':'local HTTP + real model',syntheticText:true,physicalDevice:false,turns:[]};
async function call(path,input){const res=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(input),signal:AbortSignal.timeout(120000)});if(!res.ok)throw new Error('HTTP '+res.status);return(await readModelEvents(res)).result;}
try{
 report.health=await(await fetch(base+'/api/health',{headers})).json();if(report.health.version!=='0.4.0')throw new Error('版本不匹配');
 const t=newTopic('host'),s=t.sessions[0];s.confirmed=true;t.title='第一个陌生用户之后';
 const turns=[['0','我是今天的主持人小林，今天想了解你做校园工具的经历。是什么让你开始做这个项目的？'],['1','我是今天的嘉宾小周。我没有辞职，也没有融资。起初只是帮社团整理报名表，后来三个不认识的人主动来用，我才决定继续做。'],['0','你说不认识的人愿意用，具体发生过什么？'],['1','其中一个用户在报名截止前打电话找我，他的表单没有保存。我花了两个小时帮他补回数据，这让我发现大家更在意可靠，而不是功能多。'],['1','以后我希望增加自动提醒，但目前还没做。现在只有我一个人维护，每周大约花六小时。']];
 for(const [voice,text]of turns){const seg=addSegment(s,text,'manual');seg.role='unknown';seg.speakerKey='test-stream:'+voice;if(s.speakerBindings[seg.speakerKey]){seg.role=s.speakerBindings[seg.speakerKey];seg.roleSource=s.speakerBindingSources[seg.speakerKey];}const changed=applyRoles(s,await call('/api/identify-speakers',roleContext(s)),roleContext(s));
 for(const target of s.segments.filter(x=>x.id===seg.id||changed.includes(x.id))){const ctx={...contextFor(t,s,target),segmentRevision:target.revision};const raw=await call('/api/analyze',ctx);applyAnalysis(s,target,raw,ctx,'model');report.turns.push({text:target.text,role:target.role,result:raw,displayed:activeQuestion(s)?.text});}
 }
 s.endedAt=new Date().toISOString();const context=summaryContext(t,s);report.summary=await call('/api/summarize',context);validateSummary(report.summary,context);
 report.checks={automaticHost:s.segments[0].role==='host',automaticGuest:s.segments[1].role==='guest',sameVoicePropagated:s.segments[4].role==='guest',hasSummary:report.summary.overview.length>0,allChapters:report.summary.chapters.length===s.items.length,quotedGuestOnly:report.summary.overview.every(p=>p.sources.every(ref=>s.segments.find(x=>x.id===ref.segmentId)?.role==='guest')),noHostClaims:report.turns.filter(x=>x.role==='host').every(x=>!x.result.claims.length),hasLiveCandidates:report.turns.some(x=>x.result.candidates.length>0)};
 report.passed=Object.values(report.checks).every(Boolean);if(!report.passed)process.exitCode=1;
}catch(e){report.error=e.message;report.passed=false;process.exitCode=1;}finally{if(server)await new Promise(r=>server.close(r));await writeFile(new URL('../evidence/'+(cloud?'cloud':'local')+'-interview-0.4.0.json',import.meta.url),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({passed:report.passed,checks:report.checks,error:report.error}));
