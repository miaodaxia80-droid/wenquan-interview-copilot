// 仅对明确选择的演示脚本提供固定结果；不是模型，也不分析自由输入。
export const DEMOS = {
  host: [
    { role: 'guest', itemId: 'origin', text: '当时工作挺稳定的，但我总想试试自己的东西。', claim: '嘉宾自述有稳定工作，同时想做自己的项目。', question: '是什么具体经历让你决定真的开始？', extra: '你说的自己的东西，当时有明确想法吗？' },
    { role: 'host', itemId: 'origin', text: '是什么具体经历让你决定真的开始？' },
    { role: 'guest', itemId: 'origin', text: '朋友请我帮忙做个小工具，做完以后，有几个陌生人也愿意用。', claim: '嘉宾自述帮朋友做工具后获得陌生用户。', question: '看到陌生人开始用，你做的第一个决定是什么？' },
    { role: 'guest', itemId: 'choice', text: '后来我决定先不辞职，下班后继续做。', claim: '嘉宾自述先保留工作，利用下班时间继续项目。', question: '当时为什么决定先保留工作？', extra: '你怎么安排工作和项目的时间？' }
  ],
  fde: [
    { text: '想让 AI 自动处理售后工单，分到对应小组，越快越好。', itemId: 'boundary', claim: '受访者期望自动分派，当前执行权限仍不明确。', kind: 'future', status: 'vague', question: 'AI 是给分派建议，还是直接修改工单？', gap: '“自动处理”没有说明实际写入权限和人工确认边界。' },
    { text: '第一版先建议，由值班同事确认。投诉件找主管。', itemId: 'boundary', claim: '第一版由 AI 提建议，值班同事确认。', kind: 'current', status: 'stated', questionItem: 'rules', question: '主管暂时联系不上时，投诉件怎么处理？', gap: '已明确由人确认，但投诉升级还缺少主管未响应时的处理方式。' },
    { text: '有些工单标签写普通咨询，正文却是重复投诉，还要查历史记录。', role: '一线客服', itemId: 'rules', claim: '工单标签与正文可能不一致，判断还需要历史记录。', kind: 'current', status: 'vague', question: '标签和正文不一致时，目前按什么判断？', gap: '提到了冲突的输入，但没有说明优先级和具体判据。' },
    { text: '历史记录能否接给你们，需要找 IT 确认。', role: '一线客服', itemId: 'system', claim: '历史记录的访问方式和范围需要 IT 确认。', kind: 'unknown', status: 'vague', question: '关于历史记录接口，应该找哪位 IT 同事确认？', gap: '系统访问依赖仍未确认，尚无具体协调对象。', action: '请 IT 确认历史工单查询方式、访问范围与可用样例。' }
  ],
  research: [
    { text: '那个报名表不太好用，我就没填了。', itemId: 'step', claim: '用户表示报名表不好用并放弃，具体步骤未知。', kind: 'current', status: 'vague', question: '你上次是填到哪一步停下来的？', gap: '只有总体评价，尚未说明具体发生在哪一步。' },
    { text: '我填到上传证明那一步，手机里的 PDF 一直传不上去，换了两次也不行，就关掉了。', itemId: 'step', claim: '用户在上传证明步骤遇到 PDF 上传失败，尝试两次后关闭。', kind: 'current', status: 'stated', questionItem: 'intent', question: '当时你想通过报名完成什么？', gap: '已知道卡住的步骤，还不了解用户当时的目标。' }
  ]
};
export function demoAnalysis(template, segment, context) {
  if (segment.source !== 'demo') throw new Error('离线模式只运行标注为演示的固定脚本。自由输入请连接模型后分析。');
  const f = DEMOS[template]?.find(d => d.text === segment.text);
  if (!f || !context.items.some(i => i.id === f.itemId)) throw new Error('此片段或清单已经修改，请切换模型模式或使用原始演示模板。');
  if (template === 'host') {
    if (segment.role !== f.role) throw new Error('演示角色已经修改，请使用模型重新分析。');
    const evidence = {segmentId: segment.id, quote: f.text};
    if (f.role === 'host') return { analysisVersion: 2, candidates: [], claims: [], responses: [], hostQuestions: [{...evidence, text: f.text, itemId: f.itemId, questionId: context.questions.find(q=>q.text===f.text && ['candidate','displayed'].includes(q.status))?.id || null}] };
    const responses = context.questions.filter(q=>['asked','candidate','displayed','deferred'].includes(q.status) && q.itemId===f.itemId && segment.text!==DEMOS.host[0].text).map(q=>({...evidence,questionId:q.id}));
    return {analysisVersion:2, claims:[{...evidence,itemId:f.itemId,text:f.claim,kind:'current',status:'vague'}], candidates:[f.question,f.extra].filter(Boolean).map((text,index)=>({...evidence,itemId:f.itemId,text,type:'deepen',basisType:'transcript',informationGoal:index?'具体安排或想法':'开始或选择的原因',gap:'固定脚本示例，请勿视为实时模型理解'})), responses,hostQuestions:[]};
  }
  const ref = { segmentId: segment.id, quote: f.text };
  return {
    claims: [{ ...ref, itemId: f.itemId, text: f.claim, kind: f.kind, status: f.status }],
    question: context.items.some(i => i.id === (f.questionItem || f.itemId)) ? { ...ref, itemId: f.questionItem || f.itemId, text: f.question, gap: f.gap, role: segment.role } : null,
    actions: f.action ? [{ ...ref, text: f.action }] : []
  };
}
