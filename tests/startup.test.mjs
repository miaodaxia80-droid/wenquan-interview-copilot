import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as core from '../web/core.js';
import {hostPrepare} from '../web/interview-ui.js';
import {availableQuestions, ensureInterviewSuggestion, interviewDisplay} from '../web/interview.js';
import { DEMOS } from '../web/fixtures.js';
import { requestDeadline, abortable, last } from '../web/platform.js';
import { readModelEvents } from '../web/model-stream.js';
import { runInForeground } from '../web/foreground.js';
import { createInterviewStore } from '../web/interview-storage.js';

function appHarness({ emptyItem = false, storageFailure = false } = {}) {
  const state = core.newState('fde'); state.settings.backend = 'https://cloud.test/wenquan';
  const session = core.current(state).session;
  const handlers = new Map(), nodes = new Map(), button = { disabled: false, textContent: '' };
  const itemNodes = session.items.map((item, index) => ({
    dataset: { item: item.id },
    querySelector: selector => ({ value: emptyItem && index === 0 ? '' : selector.includes('label') ? item.label : item.question })
  }));
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', classList: { add() {} }, addEventListener(name, callback) { handlers.set(id + ':' + name, callback); }, querySelector() { return button; }, scrollIntoView() {} });
    return nodes.get(id);
  };
  node('prepare-form').elements = { title: { value: '启动回归测试' }, goal: { value: session.goal }, role: { value: session.role } };
  const document = {
    getElementById: id => ['hud', 'transcript'].includes(id) ? null : node(id),
    querySelectorAll: selector => selector === '.item-editor' ? itemNodes : [],
    querySelector: () => node('brand'),
    createElement: () => ({}), addEventListener(name, callback) { handlers.set('document:' + name, callback); }
  };
  let opened = 0;
  const gm = {
    runtime: { async getLifecycleState() { return { state: 'running' }; }, async getCapabilities() { return { methods: ['audio.openCapture'] }; } },
    storage: { async get() { return { value: null }; }, async set() { if (storageFailure) throw new Error('PERMISSION_DENIED'); } }
  };
  const context = vm.createContext({
    ...core, ensureInterviewSuggestion, interviewDisplay, DEMOS, last, requestDeadline, runInForeground, createInterviewStore, document, window: { scrollTo() {}, addEventListener() {} },
    AbortController, location: { origin: 'https://mobile.test' }, localStorage: { getItem() { return null; } },
    DEFAULT_GATEWAY: state.settings.backend, DEFAULT_GATEWAY_TOKEN: 'test-only-device-code-32-characters',
    accessForGateway: () => 'test-only-device-code-32-characters', normalizeBackend: x => x, endpoint: (base, path) => base + path,
    networkFailure: error => error, drawHint() {},
    setTimeout(callback, ms) { const timer = setTimeout(callback, ms); timer.unref(); return timer; }, clearTimeout,
    async fetch() { return { ok: true, async json() { return { asr: { streaming: true } }; } }; },
    async startNativeRecording() { opened++; return { stop: async () => {} }; }, fixtureState: state, fixtureGm: gm
  });
  return { context, handlers, nodes, node, button, opened: () => opened };
}
async function loadApp(options) {
  const harness = appHarness(options);
  const source = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('void initialize();', '');
  vm.runInContext(source + `\nstate = fixtureState; bridge = { gm: fixtureGm }; ready = storageLoaded = true; presenter = { present: () => new Promise(() => {}) };`, harness.context);
  return harness;
}
test('实际清单点击处理立即切换页面，眼镜显示永久等待也不阻止音频启动', async () => {
  const h = await loadApp();
  let prevented = false;
  h.handlers.get('main:click')({ target: { closest: () => h.button }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.match(h.node('main').innerHTML, /清单已确认，正在启动录音|正在保存访谈/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.opened(), 1);
  assert.equal(h.button.disabled, true);
});
test('空白清单项在页面持久显示错误，不依赖 WebView 原生表单提示', async () => {
  const h = await loadApp({ emptyItem: true });
  await vm.runInContext('confirmAndRecord()', h.context);
  assert.match(h.node('main').innerHTML, /新增的空白事项请填写或移除/);
  assert.match(h.node('main').innerHTML, /id="preparation-error"[^>]*role="alert" >/);
  assert.equal(h.opened(), 0);
});
test('存储拒绝显示清单未保存并停止启动，不被眼镜或短暂 toast 掩盖', async () => {
  const h = await loadApp({ storageFailure: true });
  await vm.runInContext('confirmAndRecord()', h.context);
  assert.match(h.node('main').innerHTML, /访谈清单未能保存/);
  assert.match(h.node('main').innerHTML, /PERMISSION_DENIED/);
  assert.equal(h.node('storage-error').hidden, false);
  assert.match(h.node('storage-error-detail').textContent, /暂勿关闭页面/);
  assert.equal(h.opened(), 0);
});
test('应用实际保存入口在手机 64 KB 限制下保存长转写并可重新恢复', async () => {
  const h = await loadApp(), values = new Map();
  h.context.fixtureGm.storage = {
    async get(key) { return { value: values.get(key) ?? null }; },
    async set(key, value) {
      assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024);
      values.set(key, JSON.parse(JSON.stringify(value)));
    },
    async remove(key) { values.delete(key); }
  };
  vm.runInContext(`for(let i=0;i<100;i++) addSegment(current(state).session, '嘉宾回答与完整原话。'.repeat(100), 'audio');`, h.context);
  const expected = vm.runInContext('JSON.stringify(state)', h.context);
  assert.ok(Buffer.byteLength(expected) > 64 * 1024);
  await vm.runInContext('save({strict:true})', h.context);
  const restored = await createInterviewStore({ get: async key => values.get(key) }).load();
  assert.equal(JSON.stringify(restored), expected);
});
test('旧 WebView 缺少 structuredClone、findLast、at 和 Object.hasOwn 时仍可保存与显示追问', async () => {
  const source = (await readFile(new URL('../web/core.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ last, hasOwn: (o, k) => Object.prototype.hasOwnProperty.call(o, k), crypto: { getRandomValues: buffer => buffer.fill(7) }, Uint8Array });
  vm.runInContext('Array.prototype.findLast = undefined; Array.prototype.at = undefined; Object.hasOwn = undefined;', context);
  const result = vm.runInContext(source + `\nconst state = newState('fde'); const copy = clone(state); const session = current(copy).session; session.questions.push({status:'suggested', text:'仍可显示'}); ({id: session.id, question: activeQuestion(session).text, copied: copy !== state});`, context);
  assert.equal(result.question, '仍可显示'); assert.equal(result.copied, true); assert.match(result.id, /^[a-f0-9-]{36}$/);
});
test('无 AbortSignal 静态方法的请求仍可取消，宿主永久不响应也有超时', async () => {
  const parent = new AbortController(), deadline = requestDeadline(parent.signal, 5000);
  const pending = abortable(() => new Promise(() => {}), deadline.signal);
  parent.abort(new Error('取消启动')); await assert.rejects(pending, /取消启动/); deadline.dispose();
  await assert.rejects(runInForeground({ runtime: { getLifecycleState: () => new Promise(() => {}) } }, () => {}, { timeoutMs: 5 }), /未响应/);
});

test('实际主题入口可新建、重新打开和续访，始终选择目标主题的末次会话', async () => {
  const h = await loadApp();
  vm.runInContext('presenter = { present: async () => {} };', h.context);
  const click = async dataset => h.handlers.get('document:click')({ target: { closest: () => ({ dataset }) } });
  const firstId = vm.runInContext('state.topicId', h.context);
  await click({ action: 'new-topic', template: 'research' });
  assert.equal(vm.runInContext('current(state).topic.template', h.context), 'research');
  assert.equal(vm.runInContext('view', h.context), 'prepare');
  assert.equal(vm.runInContext('state.topics.length', h.context), 2);
  await click({ action: 'open-topic', id: firstId });
  assert.equal(vm.runInContext('state.topicId', h.context), firstId);
  assert.equal(vm.runInContext('view', h.context), 'live');
  vm.runInContext('current(state).session.endedAt = now();', h.context);
  await click({ action: 'resume-topic', id: firstId });
  assert.equal(vm.runInContext('current(state).topic.sessions.length', h.context), 2);
  assert.equal(vm.runInContext('state.sessionId === last(current(state).topic.sessions).id', h.context), true);
  assert.equal(vm.runInContext('view', h.context), 'prepare');
  assert.equal(h.opened(), 0);
});

test('分析过程显示进度，未完成流不能写入，眼镜发送不阻塞完成', async () => {
  const h = await loadApp();
  h.context.readModelEvents = readModelEvents; h.context.ReadableStream = ReadableStream;
  let end;
  const body = new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'delta', text: '{"question":{"text":"草稿？"}}' }) + '\n'));
    end = () => { c.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'result', result: { claims: [], question: null, actions: [] } }) + '\n')); c.close(); };
  } });
  h.context.fetch = async () => new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } });
  const pending = vm.runInContext(`current(state).session.confirmed = true; state.settings.mode = 'model'; const probeSegment = addSegment(current(state).session, '回归测试原话', 'manual'); analyzeSegment(probeSegment);`, h.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('probeSegment.analyzedRevision', h.context), null);
  assert.match(h.node('model-draft').textContent, /草稿/);
  end(); await pending;
  assert.equal(vm.runInContext('probeSegment.analyzedRevision', h.context), 0);
  assert.equal(vm.runInContext('busy', h.context), false);
});
test('不支持流读取的宿主仍可使用完整 JSON 接口', async () => {
  const h = await loadApp(); let accepted;
  h.context.fetch = async (_url, options) => { accepted = options.headers.Accept; return Response.json({ result: { claims: [], question: null, actions: [] } }); };
  await vm.runInContext(`current(state).session.confirmed = true; state.settings.mode = 'model'; analyzeSegment(addSegment(current(state).session, '兼容性测试', 'manual'));`, h.context);
  assert.equal(accepted, undefined); assert.equal(vm.runInContext('busy', h.context), false);
});

test('结束访谈会等待正在取消的分析，防止忙碌状态吞掉结束后的自动整理',async()=>{
 const h=await loadApp();let release;h.context.fixturePending=new Promise(r=>{release=r;});
 vm.runInContext('presenter={present:async()=>{}};current(state).session.confirmed=true;ongoingAnalysis=fixturePending;',h.context);
 const ending=h.handlers.get('document:click')({target:{closest:()=>({dataset:{action:'end'}})}});
 await new Promise(r=>setImmediate(r));assert.equal(vm.runInContext('!!current(state).session.endedAt',h.context),false);
 release();await ending;assert.equal(vm.runInContext('!!current(state).session.endedAt',h.context),true);assert.equal(vm.runInContext('view',h.context),'results');
});

test('准备页打开分析设置只打开弹窗，不隐式提交录音表单',async()=>{
 const h=await loadApp();h.node('settings').showModal=()=>{};
 assert.match(vm.runInContext('serviceBar()',h.context),/<button type="button" data-action="settings">/);
 await h.handlers.get('document:click')({target:{closest:()=>({dataset:{action:'settings'}})}});
 assert.equal(h.opened(),0);assert.equal(vm.runInContext('current(state).session.confirmed',h.context),false);
});


test('六种模板入口建立独立 v2 访谈，保留原记录，不开录音也不灌入答案',async()=>{
 const h=await loadApp();h.context.hostPrepare=hostPrepare;h.context.availableQuestions=availableQuestions;
 vm.runInContext('presenter={present:async()=>{}};',h.context);
 const html=vm.runInContext('renderTopics()',h.context);
 assert.equal((html.match(/data-action="new-topic"/g)||[]).length,6);
 assert.doesNotMatch(html,/体验示例|open-script-preset|小林|小周/);
 for(const template of ['aidol','host','user_research','requirements','retrospective','expert']){
  await h.handlers.get('document:click')({target:{closest:()=>({dataset:{action:'new-topic',template}})}});
  assert.equal(vm.runInContext('current(state).session.analysisVersion',h.context),2);
  assert.ok(vm.runInContext('current(state).session.items.length',h.context)>=4);
  assert.equal(vm.runInContext('current(state).session.segments.length',h.context),0);
  assert.equal(vm.runInContext('current(state).session.confirmed',h.context),false);
  assert.equal(vm.runInContext('view',h.context),'prepare');
 }
 assert.equal(h.opened(),0);assert.equal(vm.runInContext('state.topics.length',h.context),7);
 assert.equal(vm.runInContext('state.topics[0].template',h.context),'fde');
});

test('眼镜待机画面需要已确认的活动访谈，暂停或结束仍清屏',async()=>{
 const h=await loadApp();h.context.frames=[];
 vm.runInContext(`state=newState('host');storageLoaded=ready=true;presenter={present:async(_canvas,clear,metadata)=>frames.push({clear,metadata})};`,h.context);
 await vm.runInContext('syncGlasses()',h.context);assert.equal(h.context.frames.at(-1).clear,true);
 await vm.runInContext('current(state).session.confirmed=true;syncGlasses()',h.context);assert.equal(h.context.frames.at(-1).clear,false);assert.equal(h.context.frames.at(-1).metadata.questionId,null);
 await vm.runInContext('current(state).session.paused=true;syncGlasses()',h.context);assert.equal(h.context.frames.at(-1).clear,true);
 await vm.runInContext('current(state).session.paused=false;current(state).session.endedAt=now();syncGlasses()',h.context);assert.equal(h.context.frames.at(-1).clear,true);
});

test('语音积压按稳定批次分析且逐段保留，不为每个短句重复调用模型',async()=>{
 const h=await loadApp();const interview=await import('../web/interview.js'),intelligence=await import('../web/intelligence.js');Object.assign(h.context,interview,intelligence);
 let calls=0;
 h.context.fetch=async(url,options)=>{
  if(url.endsWith('/api/health'))return Response.json({analysisVersions:[1,2],features:{batchAnalysis:true,automaticRoles:true}});
  const ctx=JSON.parse(options.body);calls++;assert.equal(ctx.batchIds.length,3);
  return Response.json({result:{analysisVersion:2,candidates:[],hostQuestions:[],responses:[],claims:ctx.segments.filter(x=>ctx.batchIds.includes(x.id)).map(x=>({itemId:'origin',text:x.text,quote:x.text,segmentId:x.id,kind:'current',status:'stated'}))}});
 };
 await vm.runInContext(`state=newState('host');storageLoaded=true;ready=false;state.settings.mode='model';state.settings.backend='https://cloud.test/wenquan';render=()=>{};syncGlasses=async()=>{};localStorage.setItem=()=>{};const queuedSession=current(state).session;queuedSession.confirmed=true;queuedSession.speakerBindings={'stream:1':'guest'};speechQueue=[1,2,3].map(n=>({text:'稳定分句'+n,key:'stream:'+n,streamId:'stream',speakerKey:'stream:1',sessionId:queuedSession.id,startMs:n*1000,endMs:n*1000+500,receivedAt:Date.now()}));queuedSession.pendingAsr=[...speechQueue];pumpSpeech();`,h.context);
 assert.equal(calls,1);assert.equal(vm.runInContext('queuedSession.segments.length',h.context),3);assert.equal(vm.runInContext('queuedSession.claims.length',h.context),3);assert.equal(vm.runInContext('queuedSession.pendingAsr.length',h.context),0);assert.equal(vm.runInContext('queuedSession.segments.every(s=>s.analyzedRevision===0)',h.context),true);
});

test('旧分析期间收到新发言时保存事实但收起过时提示',async()=>{
 const h=await loadApp();Object.assign(h.context,await import('../web/interview.js'),await import('../web/intelligence.js'));
 let release;h.context.fixtureBarrier=new Promise(r=>release=r);
 h.context.fetch=async(url,options)=>{
  if(url.endsWith('/api/health'))return Response.json({analysisVersions:[1,2],features:{batchAnalysis:true}});
  const ctx=JSON.parse(options.body),seg=ctx.segments.find(x=>x.id===ctx.segmentId);await h.context.fixtureBarrier;
  return Response.json({result:{analysisVersion:2,claims:[{itemId:'origin',text:seg.text,quote:seg.text,segmentId:seg.id,kind:'current',status:'stated'}],candidates:[{itemId:'origin',text:'为什么开始？',hint:'为什么开始？',informationGoal:'起因',type:'deepen',basisType:'transcript',quote:seg.text,segmentId:seg.id,gap:'缺原因'}],hostQuestions:[],responses:[]}});
 };
 const work=vm.runInContext(`state=newState('host');storageLoaded=true;ready=false;render=()=>{};syncGlasses=async()=>{};localStorage.setItem=()=>{};state.settings.mode='model';state.settings.backend='https://cloud.test/wenquan';const s2=current(state).session;s2.confirmed=true;const sg2=addSegment(s2,'开始做工具');sg2.role='guest';analyzeSegment(sg2);`,h.context);
 await new Promise(r=>setImmediate(r));vm.runInContext(`speechQueue.push({sessionId:s2.id,text:'新的话题'});`,h.context);release();await work;
 assert.equal(vm.runInContext('s2.claims.length',h.context),1);assert.equal(vm.runInContext('activeQuestion(s2)',h.context),null);
});

test('文本确认即保存并同步首个主线建议，无语音无需等模型，提纲建议不计入模型延迟',async()=>{
 const h=await loadApp();h.context.frames=[];
 vm.runInContext(`state=newState('aidol');storageLoaded=ready=true;render=()=>{};capturePreparation=()=>{};presenter={present:async(_canvas,clear,metadata)=>frames.push({clear,metadata})};`,h.context);
 await vm.runInContext('confirmAndRecord({record:false})',h.context);
 assert.equal(vm.runInContext('activeQuestion(current(state).session).source',h.context),'outline');
 assert.equal(vm.runInContext('current(state).session.segments.length',h.context),0);
 assert.equal(h.context.frames.at(-1).clear,false);assert.equal(h.context.frames.at(-1).metadata.stableAt,null);
 assert.equal(vm.runInContext('current(state).session.questions.some(q=>q.status==="asked")',h.context),false);
});
