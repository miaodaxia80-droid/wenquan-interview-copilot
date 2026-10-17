import { parseOutline, materialMarkdown } from './productivity.js';
import { roleContext, applyRoles, summaryContext, validateSummary } from './intelligence.js';
import { interviewContext, availableQuestions, selectQuestion, questionFeedback, addHostQuestion, setChapter, bindSpeaker, invalidateInterview } from './interview.js';
import { hostPrepare, hostLive, hostResults, roleOptions } from './interview-ui.js';
import { readModelEvents } from './model-stream.js';
import { last, requestDeadline } from './platform.js';
import { STATUS, KIND, TEMPLATES, uid, now, clone, newState, newTopic, newSession, current, addSegment, correctSegment, itemStatus, activeQuestion, contextFor, applyAnalysis, feedback, exportMarkdown } from './core.js';
import { DEMOS, demoAnalysis } from './fixtures.js';
import { connectBridge, GlassPresenter, drawHint } from './device.js';
import { readSelectedFile, runInForeground } from './foreground.js';
import { startNativeRecording, startFileReplay } from './recording.js';
import { inspectAudio, readAudioStream, MAX_AUDIO_BYTES, AUDIO_EXTENSIONS } from './audio-file.js';
import { DEFAULT_GATEWAY, DEFAULT_GATEWAY_TOKEN } from './config.js';
import { LOCAL_BACKEND, normalizeBackend, backendForHost, accessForGateway, endpoint, networkFailure } from './network.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const KEY = 'wenquan.interviews.v1';
let state = newState(), view = 'prepare', busy = false, ready = false, bridge, presenter, subscription;
let saveQueue = Promise.resolve(), toastTimer, request, recording = null, audioBlob = null, editing = null, deleteId = null;
let draftRole = 'unknown';
let draft = '', draftSource = 'manual', delivery = '尚未发送', runtimeActive = true, closed = false, captureEpoch = 0;
let audioName = '', audioNotice = '', pickingAudio = false;
let streamEpoch = 0, streamStatus = 'idle', streamPartial = '', streamError = '', streamSource = 'native', streamDraining = false;
let speechQueue = [], speechPump = null, speechTimer, capturedMs = 0, stopPromise;
let storageLoaded = false, prepareStarting = false, preparationError = '', streamNotice = '', startupController;
const lifetime = new AbortController();
let mobileHost = false;
let modelProgress = null;
let gatewayHealth = null;
let resumeCaptureSessionId = null;
const inputDrafts=new Map();
const openPanels=new Map(); let renderedPanelKey=null;
document.addEventListener('input',event=>{const el=event.target;if(el.id==='transcript')draft=el.value;if(el.id==='host-question'||el.id==='outline-paste'||el.dataset?.summary)inputDrafts.set(state.sessionId+':'+(el.id||el.dataset.summary),el.value);});
const ACCESS_KEY = 'wenquan.gateway-access.v1';
function gatewayToken(backend = state.settings.backend) {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(ACCESS_KEY)); } catch { /* 本机存储不可用时仍可使用安装包内的默认连接。 */ }
  return accessForGateway(backend, saved, { gateway: DEFAULT_GATEWAY, token: DEFAULT_GATEWAY_TOKEN });
}
function openSettings() {
  const f = $('settings-form'); f.elements.mode.value = state.settings.mode; f.elements.backend.value = state.settings.backend;
  f.elements.access.value = gatewayToken(); $('connection-origin').textContent = `页面来源：${location.origin}`;
  $('settings').showModal();
}
const localCanvas = document.createElement('canvas');
const time = s => new Date(s).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
function notify(message, kind = '') {
  $('toast').textContent = message; $('toast').className = `show ${kind}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').className = '', 4200);
}
function snapshotDraft() { if ($('transcript')) draft = $('transcript').value; if ($('draft-role')) draftRole = $('draft-role').value; }
function cancelRequest() { request?.abort(); captureEpoch++; }
function safeState(value) {
  if (value?.schema !== 1 || !Array.isArray(value.topics) || !value.topics.length || !value.settings || !value.topics.every(t => Array.isArray(t.sessions) && t.sessions.length)) throw new Error('保存的数据结构不兼容；未覆盖原记录。');
  for (const topic of value.topics) for (const session of topic.sessions) {
    for (const item of session.pendingAsr || []) {
      if (!session.endedAt && !session.segments.some(x => x.asr?.key === item.key)) { const segment = addSegment(session, item.text, 'audio'); segment.asr = { service: 'volcengine', key: item.key, streamId:item.streamId, receivedAt:item.receivedAt, timingUnavailable:!!item.timingUnavailable, startMs: item.startMs, endMs: item.endMs, speakerId: item.speakerId || null, reviewed: false }; attachSpeechRole(session, segment, item); }
    }
    session.pendingAsr = [];
    if (session.analysisVersion === 2) { session.speakerBindings ||= {}; session.chapterStates ||= {}; session.chapterSummaries ||= {}; session.currentChapterId ||= session.items[0]?.id; }
  }
  const result = current(value);
  if (!result.topic || !result.session) throw new Error('保存的访谈索引无效。');
  if (value.settings.captureMode !== 'continuous') value.settings = { ...value.settings, mode: 'model', captureMode: 'continuous' };
  return value;
}
function save({ strict = false } = {}) {
  if (!storageLoaded) return Promise.reject(new Error('记录尚未恢复，已阻止覆盖保存。'));
  const data = clone(state);
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    if (closed) return;
    if (ready) await runInForeground(bridge.gm, () => closed ? undefined : bridge.gm.storage.set(KEY, data), { signal: lifetime.signal });
    else localStorage.setItem(KEY, JSON.stringify(data));
  }).catch(error => {
    notify('保存失败，请先导出记录，避免关闭后丢失。', 'error');
    if (strict) throw new Error(`访谈清单未能保存：${error.message || '宿主存储未响应'}。请保持问全在前台后重试。`);
  });
  return saveQueue;
}
function setView(next) { if (recording || streamStatus === 'starting') { cancelRequest(); void stopRecording(true); } snapshotDraft(); captureEpoch++; view = next; editing = null; render(); window.scrollTo(0, 0); }
function statusList(s) {
  return `<div class="checklist">${s.items.map(item => {
    const status = itemStatus(s, item.id);
    return `<div class="check-item" data-status="${status}"><span class="check-icon">${status === 'stated' ? '✓' : status === 'vague' ? '◐' : status === 'conflict' ? '!' : '○'}</span><div class="check-copy"><h3>${esc(item.label)}</h3><p>${esc(item.question)}</p></div><span class="pill ${status}">${STATUS[status]}</span></div>`;
  }).join('')}</div>`;
}
function modelProgressMarkup() {
  return `<div class="notice model-progress" id="model-progress" role="status" aria-live="polite" ${modelProgress ? '' : 'hidden'}><p id="model-progress-label"></p><p id="model-draft-label" class="fine"></p><p id="model-draft" class="draft-question"></p></div>`;
}
function updateModelProgress() {
  if (!modelProgress) return;
  const p = modelProgress, elapsed = ((Date.now() - p.started) / 1000).toFixed(1);
  const label = p.total ? `正在归纳第 ${Math.min(p.completed+1,p.total)} / ${p.total} 部分` : p.phase === 'generating' ? `正在生成${p.task} · 已收到 ${p.chars} 字符` : p.phase === 'retrying' ? '正在重新核对原话，请稍候' : p.phase === 'validating' ? '正在核对原话与引用' : p.phase === 'connected' ? `模型已连接，正在整理${p.task}` : `正在连接模型，准备${p.task}`;
  if ($('model-progress-label')) $('model-progress-label').textContent = `${label} · ${elapsed} 秒`;
  if ($('model-draft-label')) $('model-draft-label').textContent = p.preview ? '追问草稿 · 核对通过后更新到眼镜' : p.task==='访谈归纳'?'原话已保留，正在核对内容与出处。':'原话已保留，录音和转写可继续进行。';
  if ($('model-draft')) $('model-draft').textContent = p.preview || '';
}
async function modelApi(path, data, signal, task) {
  const progress = { started: Date.now(), phase: 'connecting', chars: 0, preview: '', task };
  modelProgress = progress; render();
  let timer;
  const tick = () => { if (modelProgress !== progress) return; updateModelProgress(); timer = setTimeout(tick, 250); };
  tick();
  try {
    const result = await api(path, data, { signal, onProgress: update => { if (modelProgress === progress && !signal.aborted) { Object.assign(progress, update); updateModelProgress(); } } });
    progress.phase = 'validating'; updateModelProgress(); return result;
  } finally { clearTimeout(timer); if (modelProgress === progress) modelProgress = null; }
}
function serviceBar() { return `<div class="servicebar"><span>${state.settings.mode === 'demo' ? '离线脚本演示 · 固定结果' : '云端模型 · 流式分析'}</span><button type="button" data-action="settings">分析设置 ↗</button></div>`; }
function renderTopics() {
  const templates = Object.entries(TEMPLATES).filter(([, t]) => t.analysisVersion === 2);
  return `<div class="lead"><div class="eyebrow">每次交流，都有一个想弄清的问题</div><h1>从一个好问题开始。</h1><p class="muted">选一个适合的模板，目标与提纲已经备好。</p></div><section class="template-section" aria-labelledby="template-title"><div class="section-head"><h2 id="template-title">开始新访谈</h2><span class="fine">提纲可自由修改</span></div><div class="interview-templates">${templates.map(([key, t]) => `<article class="interview-template"><div class="between"><h3>${esc(t.label)}</h3><span class="template-time">约 ${t.minutes} 分钟</span></div><p>${esc(t.description)}</p><div class="template-outline">${t.items.map(i => esc(i[1])).join('<span aria-hidden="true"> / </span>')}</div><button class="small secondary" data-action="new-topic" data-template="${key}" aria-label="使用${esc(t.label)}模板">使用模板 <span aria-hidden="true">↗</span></button></article>`).join('')}</div></section><section class="topic-history" aria-labelledby="history-title"><div class="section-head"><h2 id="history-title">我的访谈</h2><span class="fine">${state.topics.length} 个主题</span></div>${state.topics.map(t => `<article class="topic ${t.id === state.topicId ? 'selected' : ''}"><div class="between"><h2>${esc(t.title)}</h2><span class="pill">${esc(TEMPLATES[t.template]?.label || '自定义')}</span></div><p class="muted">${t.sessions.length} 次访谈 · ${t.sessions.reduce((n, s) => n + s.segments.length, 0)} 段对话</p><p class="fine">${esc(last(t.sessions).goal)}</p><div class="row topic-actions"><button class="secondary small" data-action="open-topic" data-id="${t.id}">打开记录</button><button class="small" data-action="resume-topic" data-id="${t.id}">新一次访谈</button><button class="small danger" data-action="delete-topic" data-id="${t.id}">删除</button></div>${deleteId === t.id ? `<div class="delete-confirm">确认删除这份本机记录？此操作不能撤销，建议先导出。<div class="row"><button class="small" data-action="cancel-delete">取消</button><button class="small" data-action="download-topic" data-id="${t.id}">先导出</button><button class="small danger" data-action="confirm-delete" data-id="${t.id}">确认删除</button></div></div>` : ''}</article>`).join('')}</section>`;
}
function renderPrepare(t, s) {
  if (s.analysisVersion === 2) return hostPrepare(t, s, { progress: modelProgressMarkup(), error: preparationError, starting: prepareStarting, busy, service: serviceBar() });
  const locked = s.segments.length > 0;
  return `<div class="lead"><div class="eyebrow">先有目标，再有好问题</div><h1>这次想弄清什么？</h1><p class="muted">清单决定提醒的方向。你可以随时补充和修改。</p></div>${modelProgressMarkup()}<form id="prepare-form" novalidate><section class="card"><label>访谈主题<input name="title" value="${esc(t.title)}" required maxlength="100"></label><label>本次目标<textarea name="goal" required maxlength="1500" placeholder="例如：弄清用户上次在哪一步放弃报名，以及为什么。">${esc(s.goal)}</textarea></label><label>当前受访角色<input name="role" value="${esc(s.role)}" required maxlength="100" placeholder="例如：客服主管 / 体验用户"></label></section><section class="card"><div class="section-head"><h2>待确认清单</h2><span class="pill">由你确认</span></div><p class="fine">${locked ? '修改清单后，本次旧分析会撤回，原话保留，可重新分析。' : '模板只是候选草案。删改后，确认这些是本次真正想问的事。'}</p><div id="item-editors">${s.items.map((i, index) => `<div class="item-editor" data-item="${esc(i.id)}"><div class="row"><input aria-label="事项 ${index + 1} 名称" data-field="label" value="${esc(i.label)}" required maxlength="100"><button type="button" class="danger small" data-action="remove-item" data-id="${esc(i.id)}">移除</button></div><input aria-label="事项 ${index + 1} 问题" data-field="question" value="${esc(i.question)}" required maxlength="300"></div>`).join('')}</div><div class="row space-top"><button type="button" class="secondary small" data-action="add-item">＋ 添加事项</button><button type="button" class="small" data-action="generate-list" ${busy ? 'disabled' : ''}>根据目标生成候选</button></div></section><div class="notice">确认现场允许记录后开始。默认持续录音并发送至火山引擎，稳定分句自动保存和分析；可随时暂停或停止。</div><p id="preparation-error" class="notice error" role="alert" ${preparationError ? '' : 'hidden'}>${esc(preparationError)}</p><button type="submit" class="primary wide" ${prepareStarting || busy || s.endedAt ? 'disabled' : ''}>确认清单，${locked ? '继续' : '开始'}录音访谈 →</button></form>${s.endedAt ? '<p class="fine space-top">这次访谈已结束。请在主题页选择“新一次访谈”。</p>' : ''}${serviceBar()}`;
}
function renderCapture(s, demo, t) {
  if(s.analysisVersion===2) {
    const locked=!!s.endedAt||s.paused,active=!!recording||streamStatus==='starting'||streamStatus==='stopping';
    return `<section class="card capture-compact"><div class="section-head"><h2>正在听到</h2><span id="record-status" class="pill ${recording?'recording':''}">${recording?'录音中':locked?'已停止':'文本演练'}</span></div><p id="stream-notice" class="fine">${esc(streamNotice||'开场介绍双方角色后，将自动区分主持人与嘉宾。')}</p><div id="live-partial" class="live-transcript" role="status">${esc(streamPartial||(recording?'正在听…':'尚未开始录音，可直接输入文本演练。'))}</div><span id="capture-time" class="fine">${Math.floor(capturedMs/1000)} 秒 · ${speechQueue.length} 段处理中</span>${!locked?`<button class="small secondary" data-action="record" ${!ready||streamStatus==='starting'||streamStatus==='stopping'?'disabled':''}>${recording?'停止录音':'开始录音'}</button>`:''}${streamError?`<p class="notice error">${esc(streamError)}</p>`:''}<details class="space-top"><summary>文本演练 / 导入音频</summary><label>补充对话 · 默认自动识别角色<input id="draft-role" type="hidden" value="${draftRole}"></label><div class="row">${[['unknown','自动识别'],['host','主持人'],['guest','嘉宾']].map(([role,label])=>`<button type="button" aria-label="${label}" class="small ${draftRole===role?'secondary':''}" data-action="draft-role" data-id="${role}" aria-pressed="${draftRole===role}" ${locked?'disabled':''}>${label}</button>`).join('')}</div><textarea id="transcript" maxlength="12000" placeholder="每次输入一人的发言，建议从双方开场介绍开始。" ${locked||active?'disabled':''}>${esc(draft)}</textarea><button class="secondary small" data-action="analyze" ${busy||active||locked?'disabled':''}>保存并分析</button><button class="small" data-action="import-audio" ${busy||active||locked?'disabled':''}>导入音频</button>${audioBlob?`<p class="fine">${esc(audioName)}</p><button class="small secondary" data-action="retry-audio" ${busy||active||locked?'disabled':''}>回放并识别</button><button class="small" data-action="clear-audio">清除音频</button>`:''}${audioNotice?`<p class="notice">${esc(audioNotice)}</p>`:''}</details></section>`;
  }

  const active = ['starting', 'recording', 'stopping'].includes(streamStatus);
  const label = streamStatus === 'starting' ? '正在连接火山 ASR' : streamStatus === 'stopping' ? '等待最终转写' : recording ? (streamSource === 'file' ? '音频回放转写中' : '持续录音中') : '默认连续录音';
  return `<section class="card"><div class="section-head"><h2>实时转写</h2><span class="pill ${recording ? 'recording' : ''}" id="record-status">${label}</span></div><p id="stream-notice" class="notice" role="status">${esc(streamNotice || '确认清单后会自动启动；也可点击下方开始录音。')}</p><p class="fine" id="capture-time">${Math.floor(capturedMs / 1000)} 秒音频 · ${speechQueue.length} 段待处理</p><div class="live-transcript" id="live-partial" role="status" aria-live="polite">${esc(streamPartial || (recording ? '正在听，识别文字会显示在这里……' : '开始访谈后持续采集，边发送边识别。'))}</div><p class="fine space-top">火山 ASR 转文字 → 稳定分句保存 → 语言模型分析 → 眼镜一条追问。转写可能有误，可在下方更正。${s.analysisVersion === 2 ? '声音编号需由你绑定角色；未绑定时标记未知，可更正。' : '所有分句暂按当前角色标注，不自动区分访谈双方。'}</p><button class="primary wide space-top ${recording ? 'recording' : ''}" data-action="record" ${streamStatus === 'starting' || streamStatus === 'stopping' || !ready || s.endedAt || !s.confirmed || s.paused ? 'disabled' : ''}>${streamStatus === 'starting' ? '正在连接…' : streamStatus === 'stopping' ? '正在收尾…' : recording ? '■ 停止录音并收尾' : '◉ 开始持续录音'}</button>${streamError ? `<p class="notice error" role="alert">${esc(streamError)}</p>` : ''}<p class="fine space-top">只在本次访谈内采集。暂停、离开页面、进入后台或结束时停止；原始录音不写入问全后端磁盘。</p><details class="space-top" ${audioBlob && !active ? 'open' : ''}><summary>手动补充或导入音频</summary><label for="transcript">补充文本</label>${s.analysisVersion === 2 ? `<label>此段是谁说的？<input id="draft-role" type="hidden" value="${draftRole}"><div class="row">${[['unknown','未知角色'],['host','主持人'],['guest','嘉宾']].map(([role,label])=>`<button type="button" class="small ${draftRole === role ? 'secondary' : ''}" data-action="draft-role" data-id="${role}" aria-pressed="${draftRole === role}">${label}</button>`).join('')}</div></label>` : ''}<textarea id="transcript" placeholder="输入、粘贴或更正刚才的对话……" maxlength="12000" ${s.endedAt || active ? 'disabled' : ''}>${esc(draft)}</textarea><button class="secondary small space-top" data-action="analyze" ${busy || active || !s.confirmed || s.endedAt ? 'disabled' : ''}>${busy ? '分析中…' : '保存并分析 →'}</button><div class="row space-top"><button class="small link" data-action="import-audio" ${busy || active || s.endedAt ? 'disabled' : ''}>＋ 导入音频文件</button><span class="fine">≤ 5 MiB · 回放最长 2 分钟</span></div>${audioBlob ? `<div class="notice"><strong>${esc(audioName || '音频片段')}</strong> · ${(audioBlob.size / 1024).toFixed(0)} KiB<div class="row space-top"><button class="secondary small" data-action="retry-audio" ${busy || active ? 'disabled' : ''}>回放并流式识别</button><button class="small" data-action="clear-audio" ${active ? 'disabled' : ''}>清除音频</button></div></div>` : ''}${audioNotice ? `<p class="notice warn">${esc(audioNotice)}</p>` : ''}</details>${state.settings.mode === 'demo' ? `<div class="notice warn">固定脚本演示；开始录音会切换为真实分析。</div><button class="secondary wide" data-action="demo" ${busy || active || !s.confirmed || !demo || s.endedAt ? 'disabled' : ''}>${demo ? `运行演示片段 ${s.demoStep + 1} / ${DEMOS[t.template].length}` : '本场景演示已完成'}</button>` : ''}${serviceBar()}</section>`;
}
function renderLive(t, s) {
  if (s.analysisVersion === 2) return hostLive(t, s, { capture: renderCapture(s, DEMOS[t.template]?.[s.demoStep], t), progress: modelProgressMarkup(), editing, delivery, notice: streamNotice, error: streamError });
  const q = activeQuestion(s), count = s.items.filter(i => itemStatus(s, i.id) === 'stated').length;
  const demo = DEMOS[t.template]?.[s.demoStep];
  return `<div class="lead"><div class="between"><div><div class="eyebrow">${esc(TEMPLATES[t.template]?.label)} · 第 ${t.sessions.indexOf(s) + 1} 次访谈</div><h1>${esc(t.title)}</h1></div><button class="small" data-action="pause" ${s.endedAt ? 'disabled' : ''}>${s.paused ? '恢复录音访谈' : '暂停访谈'}</button></div><p class="muted">${esc(s.role)} · ${esc(s.goal)}</p></div>${!s.confirmed ? '<div class="notice warn">先在“准备”页确认目标和清单，再开始分析。</div>' : ''}${streamNotice || streamError ? `<div class="notice ${streamError ? 'error' : ''}" role="${streamError ? 'alert' : 'status'}"><p id="recording-progress">${esc(streamNotice)}</p>${streamError ? `<p>${esc(streamError)}</p>` : ''}</div>` : ''}${s.endedAt ? '<div class="ending">本次访谈已结束。<button data-view="results" class="link small">查看记录 →</button></div>' : ''}${modelProgressMarkup()}<div class="split"><div><section class="hint-card" aria-label="当前建议"><div class="between"><span class="eyebrow">${s.paused ? '提示已暂停' : '下一句，值得问'}</span><span class="badge">${q ? '一条就够' : '等待对话'}</span></div><p class="question ${q ? '' : 'empty'}">${q ? esc(q.text) : s.paused ? '留一点空间，认真听。' : '先听对方说，再找没问清的。'}</p>${q ? `<div class="hint-actions"><button class="primary" data-action="asked">✓ 已问</button><button data-action="deferred">稍后处理</button><button data-action="skipped">跳过</button></div><div class="quote">${esc(q.quote)}</div><p class="gap">还缺什么：${esc(q.gap)}</p><p class="fine space-top">建议向 ${esc(q.role)} 确认 · ${q.source === 'demo' ? '离线脚本演示' : '模型分析，需人工判断'}</p>` : '<p class="fine">已问只表示问题提出了，收到具体回答后再更新清单。</p>'}</section>${renderCapture(s, demo, t)}<section class="card"><div class="section-head"><h2>对话与来源</h2><span class="pill">${s.segments.length} 段</span></div>${s.segments.length ? [...s.segments].reverse().map(seg => `<article class="segment"><div class="between"><span class="fine">${esc(seg.role)} · ${time(seg.createdAt)} · ${seg.source === 'demo' ? '虚构演示' : seg.source === 'audio' ? '录音转写' : '手动文本'}</span><span class="pill">${seg.analyzedRevision === seg.revision ? '已分析' : '待分析'}</span></div>${editing === seg.id ? `<div class="edit-panel"><label>修正角色<input id="edit-role" value="${esc(seg.role)}" maxlength="100"></label><label>修正原话<textarea id="edit-text" maxlength="12000">${esc(seg.text)}</textarea></label><div class="row"><button class="secondary small" data-action="save-correction" data-id="${seg.id}">保存修正</button><button class="small" data-action="cancel-edit">取消</button></div></div>` : `<p>${esc(seg.text)}</p><div class="row"><button class="small link" data-action="edit-segment" data-id="${seg.id}" ${busy || s.endedAt ? 'disabled' : ''}>更正原话 / 角色</button><button class="small link" data-action="retry" data-id="${seg.id}" ${busy || s.endedAt || seg.analyzedRevision === seg.revision ? 'disabled' : ''}>重新分析</button></div>`}</article>`).join('') : '<p class="muted">原话会保留在这里，追问可以回到对应片段核对。</p>'}</section></div><div><section class="card"><div class="section-head"><h2>问清楚了多少</h2><span class="metric"><strong>${count}</strong>/ ${s.items.length}</span></div><div class="progress"><div style="width:${s.items.length ? count / s.items.length * 100 : 0}%"></div></div><p class="fine">“具体陈述”仍是受访者说法，未经事实核验。</p>${statusList(s)}</section><section class="card"><details><summary>眼镜同步预览 · 600 × 350</summary><canvas id="hud" class="hud" aria-label="眼镜显示预览"></canvas><p class="fine space-top" id="delivery">${esc(delivery)}</p><button class="small link" data-action="resend">重新发送当前提示</button></details></section>${!s.endedAt ? '<button class="wide space-top" data-action="end">结束访谈，整理记录 →</button>' : ''}</div></div>`;
}
function renderResults(t, s) {
  if (s.analysisVersion === 2) return hostResults(t, s, {busy,progress:modelProgressMarkup()});
  const claims = t.sessions.reduce((n, x) => n + x.claims.length, 0), segments = t.sessions.reduce((n, x) => n + x.segments.length, 0);
  return `<div class="lead"><div class="eyebrow">把没问清的事，带到下一次</div><h1>${esc(t.title)}</h1><p class="muted">访谈记录草案 · 保留原话，继续核对。</p></div><div class="summary-stats"><span class="metric"><strong>${t.sessions.length}</strong>次访谈</span><span class="metric"><strong>${segments}</strong>段原话</span><span class="metric"><strong>${claims}</strong>条陈述</span></div><div class="row"><button class="primary" data-action="download-topic" data-id="${t.id}">导出 Markdown ↓</button><button class="secondary" data-action="resume-topic" data-id="${t.id}">继续下一次访谈</button></div><section class="card"><h2>仍需要确认</h2>${statusList(s)}<p class="fine space-top">续访会保留本主题的历史陈述与角色，不会静默覆盖旧结论。</p></section>${t.sessions.map((ss, index) => `<section class="card"><div class="section-head"><h2>第 ${index + 1} 次访谈 · ${esc(ss.role)}</h2><span class="pill">${ss.endedAt ? '已结束' : '进行中'}</span></div>${ss.claims.map(c => `<article class="segment"><span class="pill ${c.status}">${KIND[c.kind]}</span> <span class="fine">${esc(c.role)} · ${c.source === 'demo' ? '脚本演示' : '模型分析'}</span><p>${esc(c.text)}</p><blockquote class="quote">${esc(c.quote)}</blockquote></article>`).join('') || '<p class="muted">尚无已接受的分析。</p>'}${ss.actions.length ? `<h3 class="space-top">后续行动</h3>${ss.actions.map(a => `<p class="gap">○ ${esc(a.text)}</p><p class="fine">负责人：未明确 · 期限：未明确</p>`).join('')}` : ''}<button class="small link space-top" data-action="open-session" data-topic="${t.id}" data-id="${ss.id}">查看这次的原话 →</button></section>`).join('')}<section class="card"><details><summary>预览完整导出内容</summary><pre>${esc(exportMarkdown(t))}</pre></details></section>`;
}
function render() {
  if (closed) return;
  if (!storageLoaded) { $('main').innerHTML = '<section class="card"><h1>正在恢复访谈记录</h1><p>请保持问全在前台。恢复完成前不会覆盖已有记录。</p><button data-action="reload">重新载入</button></section>'; return; }
  const { topic, session } = current(state);
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if(renderedPanelKey)openPanels.set(renderedPanelKey,[...document.querySelectorAll('#main details[open]')].map(el=>el.querySelector('summary')?.textContent));
  renderedPanelKey=state.sessionId+':'+view;
  $('main').innerHTML = (view === 'topics' ? renderTopics() : view === 'prepare' ? renderPrepare(topic, session) : view === 'results' ? renderResults(topic, session) : renderLive(topic, session)) + '<footer>问全·实时访谈助手 v0.5.2 · 留心听，问清楚。</footer>';
  for(const el of document.querySelectorAll('#host-question,#outline-paste,[data-summary]')){const key=state.sessionId+':'+(el.id||el.dataset.summary);if(inputDrafts.has(key))el.value=inputDrafts.get(key);}
  for(const el of document.querySelectorAll('#main details'))if(openPanels.get(renderedPanelKey)?.includes(el.querySelector('summary')?.textContent))el.open=true;
  drawPreview(); updateModelProgress();
}
function drawPreview() {
  const { session } = current(state), q = activeQuestion(session);
  drawHint(localCanvas, q, { paused: session.paused, ended: !!session.endedAt, demo: q?.source === 'demo' || state.settings.mode === 'demo', listening: !!session.confirmed, chapter: session.items.find(item => item.id === (q?.itemId || session.currentChapterId))?.label || '' });
  if ($('hud')) { $('hud').width = 600; $('hud').height = 350; $('hud').getContext('2d').drawImage(localCanvas, 0, 0); }
}
async function syncGlasses() {
  drawPreview();
  if (!ready || !runtimeActive) { delivery = '手机预览可用；尚未连接显示接口'; return; }
  const { session } = current(state);
  await presenter.present(localCanvas, session.paused || !!session.endedAt || !session.confirmed, {sessionId:session.id,questionId:activeQuestion(session)?.id || null,stableAt:session.lastAnalysis?.stableAt || null,analysisAt:session.lastAnalysis?.completedAt || null});
}
async function api(path, data, { binary = false, signal, backend = state.settings.backend, token = gatewayToken(backend), onProgress } = {}) {
  backend = normalizeBackend(backend, mobileHost);
  const deadline = requestDeadline(signal, path === '/api/summarize' ? 600000 : 90000);
  try {
    let response;
    try { response = await fetch(endpoint(backend, path), {
    method: data === undefined ? 'GET' : 'POST',
    headers: { ...(data === undefined || binary ? {} : { 'Content-Type': 'application/json' }), ...(onProgress && typeof ReadableStream !== 'undefined' ? { Accept: 'application/x-ndjson' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: data === undefined ? undefined : binary ? data : JSON.stringify(data),
    signal: deadline.signal
    }); } catch (error) { throw networkFailure(error, backend, location.origin); }
    if (response.ok && onProgress && response.headers.get('Content-Type')?.includes('application/x-ndjson')) {
      if (!response.body?.getReader) throw new Error('当前 App 不支持流式响应，请升级 App 后重试。');
      return await readModelEvents(response, { signal: deadline.signal, onProgress });
    }
    let json;
    try { json = await response.json(); } catch (error) {
      if (deadline.signal.aborted) throw networkFailure(error, backend, location.origin);
      throw new Error(`网关返回 HTTP ${response.status}，响应不是问全接口。请检查地址路径与反向代理。`);
    }
    if (!response.ok) throw new Error(json.error || '服务请求失败。');
    return json;
  } finally { deadline.dispose(); }
}
async function resolveRoles(topic, session, signal) {
  const ctx = roleContext(session);
  if (!ctx.segments.some(x => x.role === 'unknown' && x.roleSource !== 'manual')) return [];
  const revision = session.revision;
  const {result} = await modelApi('/api/identify-speakers', ctx, signal, '说话人角色');
  if (signal.aborted || current(state).session.id !== session.id || session.revision !== revision) throw Object.assign(new Error('访谈已变化，角色识别未采用。'), {name:'AbortError'});
  const changed = applyRoles(session,result,ctx);
  // Unknown turns previously produced no guest claims. Reprocess newly resolved turns in order.
  if (changed.length) { delete session.interviewSummary; await save(); }
  return changed;
}
let ongoingAnalysis=null;
function analyzeSegment(segment, batch = [segment]) {
  if(busy)return ongoingAnalysis||Promise.resolve();
  const task=analyzeSegmentImpl(segment, batch);ongoingAnalysis=task;
  return task.finally(()=>{if(ongoingAnalysis===task)ongoingAnalysis=null;});
}
async function analyzeSegmentImpl(segment, batch) {
  if (busy) return;
  const { topic, session } = current(state);
  if (session.paused) return;
  if (!session.confirmed || session.endedAt) throw new Error('请先确认访谈主线。');
  session.analysisError=''; busy = true; const controller = new AbortController(); request = controller; render();
  try {
    const source = state.settings.mode;
    let changed=[];
    if (session.analysisVersion === 2 && source !== 'demo') {
      const health = gatewayHealth?.backend===state.settings.backend && Date.now()-gatewayHealth.at<60000 ? gatewayHealth.value : await api('/api/health', undefined, { signal: controller.signal });
      gatewayHealth={backend:state.settings.backend,at:Date.now(),value:health};
      if (batch.length>1 && !health.features?.batchAnalysis) throw new Error('批次分析需要升级网关至 0.5.0；原话已保留。');
      if (!health.analysisVersions?.includes(2)) throw new Error('当前网关尚未支持主持人访谈，请更新后端；原话已保留。');
      if (health.features?.automaticRoles) {
        try { changed=await resolveRoles(topic,session,controller.signal); session.roleError=''; }
        catch(error) { if(controller.signal.aborted || error.name==='AbortError')throw error; session.roleError='自动角色识别暂不可用，原话已保留，可重试或更正。'; }
      }
    }
    const targets=session.segments.filter(x=>batch.some(b=>b.id===x.id) || changed.includes(x.id));
    // Bound each request by count and source size, preserving conversational order.
    const groups=[]; let group=[], size=0;
    for(const target of targets) { if(group.length && (group.length>=16 || size+target.text.length>24000)) {groups.push(group);group=[];size=0;} group.push(target);size+=target.text.length; }
    if(group.length)groups.push(group);
    for(const turns of groups) {
      if (controller.signal.aborted || current(state).session.id !== session.id || session.paused || session.endedAt) return;
      const target=turns[turns.length-1];
      const context=session.analysisVersion===2 ? interviewContext(topic,session,target,turns) : {...contextFor(topic,session,target),segmentRevision:target.revision};
      if(session.analysisVersion===2 && source!=='demo')context.shortHints=true;
      const raw=source==='demo'?demoAnalysis(topic.template,target,context):(await modelApi('/api/analyze',context,controller.signal,'追问')).result;
      if (closed || current(state).session.id !== session.id || controller.signal.aborted) return;
      applyAnalysis(session,target,raw,context,source);
      // Keep facts, but never push a suggestion for a turn already overtaken by queued speech.
      if(speechQueue.some(x=>x.sessionId===session.id)) {
        for(const q of availableQuestions(session))q.status='superseded';
        session.displayedQuestionId=null;
      }
      session.lastAnalysis={stableAt:target.asr?.receivedAt || null,completedAt:Date.now(),batchSize:turns.length};
    }
    await save(); render(); void syncGlasses();
  } catch (e) { if (e.name !== 'AbortError' && !controller.signal.aborted) {session.analysisError=e.message || '分析失败，原话已保留，可重试。';notify(session.analysisError,'error');await save();} }
  finally { busy = false; if(request===controller)request=null; render(); }
}
function reportFingerprint(topic,session) { return JSON.stringify([topic.title,session.goal,session.items,session.segments.map(s=>[s.id,s.revision,s.role])]); }
async function generateReport() {
  const {topic,session}=current(state);
  if(!session.endedAt || session.analysisVersion!==2 || busy)return;
  if(!session.segments.length){session.summaryError='还没有访谈内容。';render();return;}
  busy=true;session.summaryError='';session.summaryStatus='正在归纳整场访谈…';
  const controller=new AbortController();request=controller;render();
  try {
    // The last ASR segments may still be waiting when End is pressed.
    if(state.settings.mode!=='demo')await resolveRoles(topic,session,controller.signal);
    const context=summaryContext(topic,session), fingerprint=reportFingerprint(topic,session);
    const {result}=await modelApi('/api/summarize',context,controller.signal,'访谈归纳');
    const validated=validateSummary(result,context);
    if(controller.signal.aborted || current(state).session.id!==session.id || reportFingerprint(topic,session)!==fingerprint)return;
    session.interviewSummary={...validated,coverage:result.coverage,createdAt:now(),fingerprint};
    session.chapterSummaries ||= {};session.manualSummaryChapters ||= {};
    for(const chapter of validated.chapters)if(!session.manualSummaryChapters[chapter.itemId])session.chapterSummaries[chapter.itemId]=chapter.points.map(p=>p.text).join('\n');
    session.summaryStatus='';await save();
  } catch(error) {session.summaryStatus='';if(!controller.signal.aborted){session.summaryError=error.message || '归纳失败，原话已保留，可重试。';await save();}}
  finally {session.summaryStatus='';busy=false;if(request===controller)request=null;render();}
}

function capturePreparation() {
  const form = $('prepare-form'); if (!form) return;
  const { topic, session } = current(state), data = { get: name => form.elements[name].value };
  const goal = String(data.get('goal')).trim(), role = String(data.get('role')).trim();
  const items = [...document.querySelectorAll('.item-editor')].map((div) => ({ id: div.dataset.item, label: div.querySelector('[data-field=label]').value.trim(), question: div.querySelector('[data-field=question]').value.trim(), ...(session.analysisVersion === 2 ? { preparedQuestions: div.querySelector('[data-field=preparedQuestions]')?.value.trim() || '' } : {}), priority: session.analysisVersion === 2 ? Number(div.querySelector('[data-field=priority]')?.value || 1) : session.items.find(i => i.id === div.dataset.item)?.priority || 1 }));
  const hostFields = session.analysisVersion === 2 ? Object.fromEntries(['guestBackground','backgroundSource','boundaries'].map(k=>[k, String(form.elements[k]?.value || '').trim()])) : {};
  const changed = Object.entries(hostFields).some(([k,v])=>session[k]!==v) || JSON.stringify(session.items) !== JSON.stringify(items) || session.goal !== goal;
  if(session.analysisVersion===2)session.plannedMinutes=Math.max(0,Math.min(240,Number(form.elements.plannedMinutes?.value)||0));
  topic.title = String(data.get('title')).trim() || '未命名主题'; session.goal = goal; session.role = role; Object.assign(session, hostFields);
  if (changed && session.segments.length) {
    session.events.push({ type: 'checklist-edit', at: now(), priorClaims: clone(session.claims), priorQuestions: clone(session.questions), priorActions: clone(session.actions) });
    if (session.analysisVersion === 2) invalidateInterview(session);
    session.claims = []; if (session.analysisVersion !== 2) session.questions = []; session.actions = [];
    for (const seg of session.segments) seg.analyzedRevision = null;
  }
  session.items = items; if (session.analysisVersion === 2 && !items.some(i=>i.id===session.currentChapterId)) session.currentChapterId = items[0]?.id; session.confirmed = false; session.revision++;
}
function updateStreamingPreview() {
  if ($('live-partial')) $('live-partial').textContent = streamPartial || (recording ? '正在听，等待下一句……' : '录音已停止，已保留稳定分句。');
  if ($('capture-time')) $('capture-time').textContent = `${Math.floor(capturedMs / 1000)} 秒音频 · ${speechQueue.length} 段待处理`;
}
function attachSpeechRole(session, segment, item) {
  if (session.analysisVersion !== 2) return;
  segment.speakerKey = item.speakerKey || null;
  segment.role = item.speakerKey ? (session.speakerBindings?.[item.speakerKey] || 'unknown') : 'unknown';
  if(segment.role!=='unknown')segment.roleSource=session.speakerBindingSources?.[item.speakerKey] || 'manual';
}
function flushSpeechQueue() {
  const added = [];
  while (speechQueue.length) {
    const item = speechQueue.shift();
    const session = state.topics.flatMap(t => t.sessions).find(s => s.id === item.sessionId);
    if (!session || session.endedAt) continue;
    const segment = addSegment(session, item.text, 'audio');
    session.pendingAsr = (session.pendingAsr || []).filter(x => x.key !== item.key);
    segment.asr = { service: 'volcengine', key: item.key, streamId:item.streamId, receivedAt:item.receivedAt, timingUnavailable:!!item.timingUnavailable, startMs: item.startMs, endMs: item.endMs, speakerId: item.speakerId || null, reviewed: false }; attachSpeechRole(session, segment, item);
    added.push(segment);
  }
  void save(); return added;
}
function scheduleSpeech() {
  if (speechTimer) return;
  if (!speechQueue.length || streamDraining || closed) return;
  speechTimer = setTimeout(() => { speechTimer=null; void pumpSpeech(); }, 500);
}
async function pumpSpeech() {
  if (speechPump || busy || streamDraining || closed) { scheduleSpeech(); return; }
  speechPump = (async () => {
    while (speechQueue.length && !streamDraining && !closed && !busy) {
      const { session } = current(state), batch=[]; let size=0;
      do {
        const item=speechQueue[0];
        if(batch.length && size+item.text.length>24000)break;
        speechQueue.shift();
        if(session.id!==item.sessionId || session.endedAt)continue;
        const segment=addSegment(session,item.text,'audio');
        session.pendingAsr=(session.pendingAsr||[]).filter(x=>x.key!==item.key);
        segment.asr={service:'volcengine',key:item.key,streamId:item.streamId,startMs:item.startMs,endMs:item.endMs,timingUnavailable:!!item.timingUnavailable,receivedAt:item.receivedAt,speakerId:item.speakerId??null,reviewed:false};
        attachSpeechRole(session,segment,item); batch.push(segment); size+=item.text.length;
      } while(speechQueue.length && batch.length<(session.analysisVersion===2?16:1));
      await save(); if(batch.length)await analyzeSegment(batch[batch.length-1],batch);
    }
  })();
  try { await speechPump; } finally { speechPump = null; scheduleSpeech(); updateStreamingPreview(); }
}
async function beginRecording(blob = null) {
  const { session } = current(state);
  if (streamStatus !== 'idle' || recording || !session.confirmed || session.endedAt || session.paused) return;
  if (!ready && !blob) { streamError = '未连接 App 录音接口，请在 MemoMind App 中打开问全。'; render(); return; }
  const epoch = ++streamEpoch, sessionId = session.id, streamId = uid();
  streamStatus = 'starting'; streamError = ''; streamPartial = ''; capturedMs = 0; streamSource = blob ? 'file' : 'native'; streamDraining = false;
  startupController = new AbortController();
  state.settings.mode = 'model'; streamNotice = '正在保存访谈并检查录音能力…'; render();
  const valid = () => !closed && epoch === streamEpoch && current(state).session.id === sessionId && runtimeActive;
  const callbacks = {
    token: gatewayToken(),
    signal: startupController.signal,
    isCancelled: () => !valid(),
    onStage: message => { if (valid()) { streamNotice = message; for (const id of ['stream-notice', 'recording-progress']) if ($(id)) $(id).textContent = message; } },
    onPartial: text => { if (!valid()) return; streamPartial = text; updateStreamingPreview(); },
    onChunk: ms => { if (valid()) { capturedMs += ms || 0; updateStreamingPreview(); } },
    onFinal: item => {
      if (!valid()) return;
      const queued = { ...item, streamId, receivedAt:Date.now(), speakerKey: item.speakerId == null ? null : `${streamId}:${item.speakerId}`, key: `${streamId}:${item.key}`, sessionId };
      if (item.timingUnavailable) streamError = '部分转写未提供分句时间，已按稳定结果保存，请核对。';
      speechQueue.push(queued); session.pendingAsr ||= []; session.pendingAsr.push(queued); void save();
      if (speechQueue.length > 150) { streamError = '分析速度落后，录音已停止；已识别文字将保留。'; void stopRecording(true); }
      else scheduleSpeech();
      updateStreamingPreview();
    },
    onCorrection: item => {
      if (!valid()) return;
      const key = `${streamId}:${item.key}`, queued = speechQueue.find(x => x.key === key);
      if (queued) { Object.assign(queued, item, { key, speakerKey: item.speakerId == null ? null : `${streamId}:${item.speakerId}` }); const pending = session.pendingAsr?.find(x => x.key === key); if (pending) Object.assign(pending, queued); void save(); return; }
      const segment = session.segments.find(x => x.asr?.key === key);
      const speakerKey = item.speakerId == null ? null : `${streamId}:${item.speakerId}`;
      if (segment && (segment.text !== item.text || (session.analysisVersion === 2 && segment.speakerKey !== speakerKey))) { cancelRequest(); correctSegment(session, segment.id, item.text, session.analysisVersion === 2 ? (session.speakerBindings[speakerKey] || 'unknown') : segment.role, segment.roleSource || 'auto'); if (session.analysisVersion === 2) segment.speakerKey = speakerKey; void save(); streamError = '识别服务修订了稳定分句，已撤回相关旧分析，请核对并重新分析。'; render(); void syncGlasses(); }
    },
    onError: error => { if (!valid()) return; streamError = error.message; streamNotice = '录音未完成，请按下方错误提示处理后重试。'; notify(error.message, 'error'); void stopRecording(true); },
    onStopped: () => { if (!valid() || streamDraining) return; recording = null; streamStatus = 'idle'; streamPartial = ''; streamNotice = '录音已停止，已保留稳定分句。'; scheduleSpeech(); render(); }
  };
  try {
    await save({ strict: true });
    if (!valid()) return;
    void syncGlasses();
    if (!blob) {
      callbacks.onStage('正在检查 App 的眼镜音频采集能力…');
      const caps = await runInForeground(bridge.gm, () => bridge.gm.runtime.getCapabilities(), { signal: startupController.signal, timeoutMs: 8000 });
      if (!caps.methods?.includes('audio.openCapture') && !caps.audio) throw new Error('当前 App 未提供 audio.openCapture 音频接口，或未授予 audio.capture 权限。请在插件权限中允许录音；也可导入音频回放。');
    }
    callbacks.onStage('正在检测云端转写服务…');
    const health = await api('/api/health', undefined, { signal: startupController.signal });
    if(session.analysisVersion===2 && !health.features?.batchAnalysis)throw new Error('当前网关尚未升级到0.5.0，未开始录音。请先更新网关再使用本版本。');
    if (!health.asr?.streaming) throw new Error('后端尚未配置火山流式语音，请先检测服务连接。');
    if (!valid()) return;
    const opened = await (blob ? startFileReplay(blob, state.settings.backend, callbacks) : startNativeRecording(bridge.gm, state.settings.backend, callbacks));
    if (!valid()) { await opened.stop(true); return; }
    recording = opened; streamStatus = 'recording'; render();
    notify(blob ? '正在按实时速度回放文件，不使用麦克风。' : '正在持续录音并实时转写，点击停止即可收尾。');
  } catch (error) { if (valid()) { streamError = error.message || '录音启动失败，请重试。'; streamNotice = '录音未启动，请检查下方提示。'; notify(streamError, 'error'); } }
  finally { if (valid() && streamStatus === 'starting') { streamStatus = 'idle'; render(); } }
}
async function stopRecording(discard = false) {
  if (streamDraining) return stopPromise;
  if (!recording && streamStatus === 'idle' && !speechQueue.length && !speechPump) return;
  let resolveStop; stopPromise = new Promise(resolve => { resolveStop = resolve; });
  streamDraining = true; clearTimeout(speechTimer); speechTimer=null;
  if (streamStatus === 'starting') { startupController?.abort(new Error('录音启动已取消，请保持问全前台后重新开始。')); streamNotice = '录音启动已取消，可返回前台后重新开始。'; }
  const rec = recording; let added = []; streamStatus = rec ? 'stopping' : 'idle'; render();
  try {
    if (rec) await rec.stop(discard);
    if (discard) cancelRequest();
    if (speechPump) await speechPump;
    added = flushSpeechQueue();
  } catch (error) { streamError = error.message; }
  finally {
    streamEpoch++; recording = null; streamStatus = 'idle'; streamPartial = ''; streamDraining = false; streamNotice = '录音已停止，已保留稳定分句。'; render(); resolveStop(); stopPromise = null;
  }
  // 手动停止后仍分析已收到的稳定分句；暂停/结束时保留为待分析，不重新启动录音。
  if (!discard) {
    const { session } = current(state);
    const pending = added;
    for (const segment of pending) { if (closed || session.endedAt || session.paused || current(state).session.id !== session.id) break; await analyzeSegment(segment); }
  }
}
function download(topic, compact = false) {
  const blob = new Blob([compact ? materialMarkdown(topic,current(state).session) : exportMarkdown(topic)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = `${topic.title.replace(/[\\/:*?"<>|]/g, '_')}_${compact ? '素材索引' : '访谈记录'}.md`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 20000);
  notify(compact?'已生成素材索引。':'已生成完整访谈记录。');
}

document.addEventListener('click', async event => {
  const button = event.target.closest('button,[data-view]');
  if (!button || button.disabled) return;
  try {
    if (button.dataset.action === 'reload') { window.location.reload(); return; }
    if (!storageLoaded) throw new Error('请先恢复访谈记录。');
    if (button.dataset.view) { if (recording || streamStatus === 'starting') { cancelRequest(); await stopRecording(true); } setView(button.dataset.view); return; }
    const action = button.dataset.action;
    if (!action) return;
    snapshotDraft();
    const { topic, session } = current(state), id = button.dataset.id;
    if (action === 'generate-report') return await generateReport();
    if (action === 'draft-role') { if (!['host','guest','unknown'].includes(id)) return; draftRole=id; if ($('draft-role')) $('draft-role').value=id; document.querySelectorAll('[data-action="draft-role"]').forEach(b=>{ b.classList.toggle('secondary',b.dataset.id===id); b.setAttribute('aria-pressed',String(b.dataset.id===id)); }); return; }
    if (action === 'settings') {
      if ($('prepare-form')) capturePreparation();
      if (recording || streamStatus === 'starting') { cancelRequest(); await stopRecording(true); }
      openSettings(); return;
    }
    if (action === 'download-topic') return download(state.topics.find(t => t.id === id));
    if (action === 'delete-topic') { deleteId = id; render(); return; }
    if (action === 'cancel-delete') { deleteId = null; render(); return; }
    if (action === 'confirm-delete') {
      cancelRequest(); await stopRecording(true); state.topics = state.topics.filter(t => t.id !== id);
      if (!state.topics.length) state.topics.push(newTopic('custom'));
      state.topicId = state.topics[0].id; state.sessionId = last(state.topics[0].sessions).id; deleteId = null; view = 'topics'; draft = ''; await save(); await syncGlasses(); render(); return;
    }
    if (['open-topic', 'open-session', 'resume-topic', 'new-topic'].includes(action)) {
      resumeCaptureSessionId = null;
      cancelRequest(); await stopRecording(true); capturedMs = 0; streamError = ''; draft = ''; draftSource = 'manual'; audioBlob = null; audioName = ''; audioNotice = '';
      let next = state.topics.find(t => t.id === (button.dataset.topic || id));
      if (action === 'new-topic') { if (!Object.prototype.hasOwnProperty.call(TEMPLATES, button.dataset.template)) return; next = newTopic(button.dataset.template); state.topics.push(next); state.settings.mode = 'model'; draftRole = 'unknown'; }
      state.topicId = next.id;
      if (action === 'resume-topic') {
        const prior = last(next.sessions);
        if (!prior.endedAt) { notify('该主题已有进行中的访谈，已打开。'); state.sessionId = prior.id; view = prior.confirmed ? 'live' : 'prepare'; }
        else { const added = newSession(next.template, next.id, prior.items); added.goal = prior.goal; added.role = prior.role; if (prior.analysisVersion === 2) { added.guestBackground=prior.guestBackground; added.backgroundSource=prior.backgroundSource; added.boundaries=prior.boundaries; } next.sessions.push(added); state.sessionId = added.id; view = 'prepare'; }
      } else { state.sessionId = action === 'open-session' ? id : last(next.sessions).id; view = action === 'new-topic' ? 'prepare' : 'live'; }
      await save(); render(); await syncGlasses(); return;
    }
    if (action === 'add-item' || action === 'remove-item' || action === 'move-item') {
      capturePreparation();
      if (action === 'add-item') { if (session.items.length >= 30) throw new Error('最多 30 条待确认项。'); session.items.push({ id: uid(), label: '', question: '', priority: 1 }); }
      else if (action === 'remove-item') session.items = session.items.filter(i => i.id !== id);
      else { const index = session.items.findIndex(i=>i.id===id), target = index + Number(button.dataset.direction); if (index >= 0 && target >= 0 && target < session.items.length) [session.items[index],session.items[target]]=[session.items[target],session.items[index]]; }
      if (session.analysisVersion === 2 && !session.items.some(i=>i.id===session.currentChapterId)) session.currentChapterId=session.items[0]?.id;
      await save(); render(); await syncGlasses(); return;
    }
    if (action === 'import-outline') {
      const rows=parseOutline($('outline-paste')?.value);
      if(session.items.length+rows.length>30)throw new Error('追加后超过30条主线，请先移除不需要的主线。');
      capturePreparation();
      session.items.push(...rows.map(row=>({...row,id:uid()}))); session.confirmed=false;session.revision++;
      inputDrafts.delete(session.id+':outline-paste');
      await save();render();notify('提纲已追加，请确认主线顺序和必聊项。');return;
    }
    if (action === 'download-materials') { download(topic,true);return; }
    if (action === 'generate-list') {
      capturePreparation();
      if (!session.goal.trim()) throw new Error('请先写下本次目标。');
      if (state.settings.mode === 'demo') { notify('离线模式请编辑模板或手动添加事项。配置模型后可从任意目标生成候选。'); return; }
      busy = true; render(); request = new AbortController();
      const revision = session.revision;
      try {
        const { items } = await modelApi('/api/checklist', { goal: session.goal, role: session.role }, request.signal, '候选清单');
        if (current(state).session.id !== session.id || session.revision !== revision) throw new Error('目标已变化，请重新生成。');
        session.items.push(...items.map(i => ({ id: uid(), label: i.label, question: i.question, priority: 1 })).slice(0, 30 - session.items.length));
        session.confirmed = false; session.revision++; await save(); notify('候选已追加，请逐条审阅后确认。');
      } finally { busy = false; request = null; render(); }
      return;
    }
    if (session.analysisVersion === 2 && ['select-question','set-chapter','close-chapter','add-host-question','ask-deferred','live-move-item','save-summary'].includes(action)) {
      cancelRequest();
      if (action === 'select-question') selectQuestion(session,id);
      if (action === 'set-chapter' || action === 'close-chapter') setChapter(session,id,action === 'close-chapter');
      if (action === 'add-host-question') { addHostQuestion(session,$('host-question').value); inputDrafts.delete(session.id+':host-question'); }
      if (action === 'ask-deferred') { const q=session.questions.find(q=>q.id===id && q.status==='deferred'); if (q && !session.paused && !session.endedAt) { q.status='asked'; q.manuallyAsked=true; q.askedAfter=session.segments.length; session.revision++; } }
      if (action === 'live-move-item') { if (session.endedAt || session.paused) return; const i=session.items.findIndex(x=>x.id===id); if (i>=0 && i<session.items.length-1) [session.items[i],session.items[i+1]]=[session.items[i+1],session.items[i]]; session.revision++; }
      if (action === 'save-summary') { const input=[...document.querySelectorAll('[data-summary]')].find(x=>x.dataset.summary===id); if (!input || input.value.length>5000) throw new Error('摘要无效。'); session.chapterSummaries[id]=input.value; session.manualSummaryChapters ||= {}; session.manualSummaryChapters[id]=true; session.revision++; }
      await save(); render(); void syncGlasses(); return;
    }
    if (action === 'confirm-text') return await confirmAndRecord({record:false});
    if (action === 'demo') {
      const f = DEMOS[topic.template]?.[session.demoStep]; if (!f) return;
      if (f.role) session.role = f.role;
      const segment = addSegment(session, f.text, 'demo'); if (session.analysisVersion === 2) segment.role=f.role; session.demoStep++; await save();
      await analyzeSegment(segment); return;
    }
    if (action === 'analyze') {
      const seg = addSegment(session, draft, draftSource); if (session.analysisVersion === 2) { seg.role=draftRole; if(draftRole!=='unknown')seg.roleSource='manual'; } draft = ''; draftSource = 'manual'; await save();
      await analyzeSegment(seg); return;
    }
    if (action === 'retry') return await analyzeSegment(session.segments.find(seg => seg.id === id));
    if (['asked', 'skipped', 'deferred'].includes(action)) { cancelRequest(); if (session.analysisVersion === 2) questionFeedback(session, id || activeQuestion(session)?.id, action); else feedback(session, action); await save(); render(); await syncGlasses(); notify(action === 'asked' ? '已标记为提出，缺口仍等待回答。' : action === 'skipped' ? '已跳过这条提示。' : '已放入稍后处理，可在记录中查看。'); return; }
    if (action === 'pause') {
      if (!session.paused) resumeCaptureSessionId = (recording || streamStatus === 'starting') ? session.id : null;
      const resumeCapture = session.paused && resumeCaptureSessionId === session.id;
      cancelRequest(); await stopRecording(true); session.paused = !session.paused; session.revision++;
      await save(); render(); await syncGlasses();
      if (!session.paused) { resumeCaptureSessionId = null; if (resumeCapture) await beginRecording(); }
      return;
    }
    if (action === 'resend') return await syncGlasses();
    if (action === 'end') { if(session.ending)return;session.ending=true;render();try{cancelRequest();if(ongoingAnalysis)await ongoingAnalysis;await stopRecording(false);session.endedAt=now();session.revision++;delete session.ending;await save();view='results';render();void syncGlasses();if(session.analysisVersion===2)await generateReport();}finally{delete session.ending;render();}return; }
    if (action === 'edit-segment') { if (recording || streamStatus === 'starting') { cancelRequest(); await stopRecording(); } editing = id; render(); return; }
    if (action === 'cancel-edit') { editing = null; render(); return; }
    if (action === 'save-correction') {
      correctSegment(session, id, $('edit-text').value, $('edit-role').value); editing = null;
      await save(); render(); await syncGlasses(); notify(session.endedAt ? '已保留更正与原始输入，旧分析已撤回；结束后的记录不会自动分析。' : '已保留原始输入，撤回本次旧分析，请重新分析相关片段。'); return;
    }
    if (action === 'record') { if (recording) await stopRecording(); else await beginRecording(); return; }
    if (action === 'import-audio') {
      if (busy || recording || session.endedAt) return;
      if (!ready) { $('audio-file-input').click(); return; }
      const epoch = ++captureEpoch, sessionId = session.id;
      busy = true; pickingAudio = true; request = new AbortController(); render();
      try {
        const { files } = await bridge.gm.files.pick({ extensions: AUDIO_EXTENSIONS, allowMultiple: false });
        if (!files.length || epoch !== captureEpoch || sessionId !== state.sessionId || closed) return;
        if (files[0].size > MAX_AUDIO_BYTES) throw new Error('音频超过 5 MiB，请先截取较短片段。');
        const file = await readSelectedFile(bridge.gm, files[0].fileId, { signal: request.signal });
        const { blob } = await readAudioStream(file.stream);
        if (epoch !== captureEpoch || sessionId !== state.sessionId || closed || request.signal.aborted) return;
        audioBlob = blob; audioName = files[0].name; audioNotice = '音频已导入。点击“回放并流式识别”后才发送；回放时自动保存稳定分句并分析。';
      } catch (e) { if (e.name !== 'AbortError') { audioNotice = `${e.message} 可直接输入文字继续。`; notify(audioNotice, 'error'); } }
      finally { pickingAudio = false; busy = false; request = null; render(); }
      return;
    }
    if (action === 'clear-audio') { audioBlob = null; audioName = ''; audioNotice = ''; render(); return; }
    if (action === 'retry-audio') return await beginRecording(audioBlob);
  } catch (e) { notify(e.message || String(e), 'error'); busy = false; render(); }
});
async function confirmAndRecord({ record = true } = {}) {
  if (prepareStarting) return;
  prepareStarting = true; preparationError = '';
  const button = $('prepare-form')?.querySelector('button[type="submit"]');
  if (button) { button.disabled = true; button.textContent = '正在确认清单…'; }
  try {
    capturePreparation(); const { session } = current(state);
    if (!session.goal || !session.role || !session.items.length || session.items.some(i => !i.label || !i.question)) throw new Error('请填好目标、角色，并至少确认一条完整事项；新增的空白事项请填写或移除。');
    if (session.endedAt) throw new Error('这次访谈已结束，请新建一次访谈。');
    if(!session.segments.length)session.startedAt=now();
    session.confirmed = true; session.paused = false;
    // 先显示启动状态；存储和眼镜传输不再让准备页看起来毫无反应。
    view = 'live'; streamNotice = '清单已确认，正在启动录音…'; streamError = ''; render(); window.scrollTo(0, 0);
    if (state.settings.mode === 'model' && record) await beginRecording();
    else { await save({ strict: true }); streamNotice = state.settings.mode === 'demo' ? '当前为离线演示；点击开始录音可切换到真实转写。' : '主线已确认；可手动补充带角色的转写，或开始持续录音。'; render(); void syncGlasses(); }
  } catch (error) {
    preparationError = error.message || '清单确认失败，请检查输入后重试。';
    streamError = preparationError; render(); notify(preparationError, 'error');
    const errorBox = $('preparation-error');
    errorBox?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  } finally { prepareStarting = false; if (view === 'prepare') render(); }
}
document.addEventListener('change', async event => {
  if (!event.target.dataset?.speaker) return;
  try { cancelRequest(); const {session}=current(state); bindSpeaker(session,event.target.dataset.speaker,event.target.value); await save(); render(); void syncGlasses(); notify('角色已绑定，旧分析已撤回；请重新分析稳定转写。'); }
  catch(error) { notify(error.message,'error'); render(); }
});
document.addEventListener('submit', event => {
  if (event.target.id !== 'prepare-form') return;
  event.preventDefault(); void confirmAndRecord();
});
// 部分 App WebView 的原生表单验证提示不可见；按钮统一交给显式校验。
$('main').addEventListener('click', event => {
  if (!event.target.closest('#prepare-form button[type="submit"]')) return;
  event.preventDefault(); void confirmAndRecord();
});
$('settings-form').onsubmit = async event => {
  event.preventDefault(); const form = event.target;
  try {
    const backend = normalizeBackend(form.elements.backend.value, mobileHost);
    const token = form.elements.access.value.trim();
    if (token && (token.length < 32 || token.length > 256)) throw new Error('设备访问码长度应为 32–256 个字符。');
    // 访问码单独存入插件 WebView 本地存储，不经过会打印参数的 Bridge，也不进入访谈导出。
    localStorage.setItem(ACCESS_KEY, JSON.stringify({ backend, token }));
    state.settings = { ...state.settings, mode: form.elements.mode.value, backend, backendExplicit: true }; cancelRequest(); await save(); $('settings').close(); render(); notify('分析设置已保存。');
  } catch (error) { notify(error.message, 'error'); }
};
$('close-settings').onclick = () => $('settings').close();
$('import-connection').onclick = () => {
  try {
    const profile = JSON.parse($('connection-profile').value);
    const backend = normalizeBackend(profile.gateway, true);
    if (typeof profile.accessCode !== 'string' || profile.accessCode.length < 32 || profile.accessCode.length > 256) throw new Error('连接配置中的设备访问码无效。');
    $('settings-form').elements.backend.value = backend; $('settings-form').elements.access.value = profile.accessCode;
    $('connection-profile').value = ''; $('service-status').textContent = '连接配置已填入，请检测连接后保存。';
  } catch (error) { $('service-status').textContent = error instanceof SyntaxError ? '请粘贴完整的连接配置 JSON。' : error.message; }
};
$('check-service').onclick = async () => {
  try {
    const s = await api('/api/health', undefined, { backend: $('settings-form').elements.backend.value, token: $('settings-form').elements.access.value.trim() });
    $('service-status').textContent = `后端已连接（${s.version}）· 文本模型${s.modelConfigured ? `已配置：${s.model?.name || ''}` : '未配置'} · 语音转写${s.asrConfigured ? `已配置：${s.asr?.name || ''}` : '未配置'}。配置存在不代表云端调用已经成功。`;
  } catch (error) { $('service-status').textContent = error.message; }
};
document.querySelector('.brand').onclick = event => { event.preventDefault(); setView('topics'); };
$('audio-file-input').onchange = async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  try { const media = await inspectAudio(file); audioBlob = new Blob([file], { type: media.mime }); audioName = file.name; audioNotice = '音频已导入。点击“回放并流式识别”后才发送；回放时自动保存稳定分句并分析。'; }
  catch (e) { notify(e.message, 'error'); }
  render();
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !pickingAudio) { cancelRequest(); void stopRecording(true); }
});
window.addEventListener('pagehide', () => {
  closed = true; lifetime.abort(); cancelRequest(); void stopRecording(true); clearTimeout(toastTimer);
  // Host 在卸载时已经撤销旧运行代际；此时不能再向旧会话发送 Bridge 请求。
  presenter?.close(); bridge?.close();
});
async function initialize() {
  render();
  try {
    bridge = connectBridge((type, data) => {
      if (type === 'connection') {
        if (data.connected) { $('bridge-badge').textContent = '设备已连接'; void syncGlasses(); }
        else { $('bridge-badge').textContent = '设备已断开'; delivery = '设备断开，手机可继续使用'; cancelRequest(); void stopRecording(true); }
      }
      if (type === 'lifecycle') {
        runtimeActive = data.state === 'running';
        if (!runtimeActive && !pickingAudio) { cancelRequest(); void stopRecording(true); if (ready) void presenter.present(localCanvas, true); }
        else void syncGlasses();
      }
    });
    let bootstrapTimer;
    try { await Promise.race([bridge.gm.ready(), new Promise((_, reject) => { bootstrapTimer = setTimeout(() => reject(new Error('Bridge timeout')), 7000); })]); }
    finally { clearTimeout(bootstrapTimer); }
    ready = true;
    presenter = new GlassPresenter(bridge.gm, message => { delivery = message; if ($('delivery')) $('delivery').textContent = message; }, receipt => {
      const meta=receipt.metadata, session=state.topics.flatMap(t=>t.sessions).find(s=>s.id===meta?.sessionId);
      if(!session || receipt.clear || !meta.questionId || !meta.stableAt)return;
      session.deliveryMetrics ||= [];
      if(session.deliveryMetrics.some(x=>x.questionId===meta.questionId))return;
      session.deliveryMetrics.push({questionId:meta.questionId,stableAt:meta.stableAt,analysisAt:meta.analysisAt,confirmedAt:receipt.confirmedAt,stableToDisplayMs:receipt.confirmedAt-meta.stableAt});
      session.deliveryMetrics=session.deliveryMetrics.slice(-200);void save();
    });
    try { const saved = (await runInForeground(bridge.gm, () => bridge.gm.storage.get(KEY), { signal: lifetime.signal })).value; if (saved) state = safeState(saved); storageLoaded = true; }
    catch (e) { notify(e.message || '未能恢复本机记录，请检查存储权限。', 'error'); render(); return; }
    try { subscription = (await bridge.gm.device.subscribeEvents(['connection'])).subscriptionId; } catch { /* 可选权限：不阻塞文本访谈。 */ }
    let info;
    try { info = await bridge.gm.device.getInfo(); } catch { /* 可选权限。 */ }
    mobileHost = info?.transport !== 'desktop-simulator';
    const backend = backendForHost(state.settings.backend, info?.transport, DEFAULT_GATEWAY, !!DEFAULT_GATEWAY_TOKEN, state.settings.backendExplicit);
    if (backend !== state.settings.backend) { state.settings.backend = backend; await save(); }
    $('bridge-badge').textContent = info?.transport === 'desktop-simulator' ? 'Studio 模拟器' : info?.connected ? '设备已连接' : 'App 已连接';
    $('bridge-badge').classList.add('ok'); render(); await syncGlasses();
    if (mobileHost && (!state.settings.backend || !gatewayToken())) openSettings();
  } catch {
    if (ready) { render(); return; }
    try { const value = localStorage.getItem(KEY); if (value) state = safeState(JSON.parse(value)); }
    catch { notify('浏览器存储不可用或记录损坏，请先导出重要记录。', 'error'); }
    storageLoaded = true; state.settings.backend ||= DEFAULT_GATEWAY || LOCAL_BACKEND; $('bridge-badge').textContent = '手机页面预览'; render();
  }
}
void initialize();
