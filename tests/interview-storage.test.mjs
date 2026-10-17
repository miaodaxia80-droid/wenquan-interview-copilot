import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterviewStore } from '../web/interview-storage.js';
import { newState, newTopic, current, addSegment } from '../web/core.js';
const KEY = 'wenquan.interviews.v1';
function phoneStorage(initial) {
  const values = new Map(initial ? [[KEY, structuredClone(initial)]] : []);
  let fail, writes = 0;
  const adapter = {
    async get(key) { return structuredClone(values.get(key) ?? null); },
    async set(key, value) {
      assert.ok(Buffer.byteLength(JSON.stringify(value), 'utf8') <= 64 * 1024, '模拟真实手机单项 64 KB 上限');
      writes++;
      if (fail?.(key, value, writes, false)) throw new Error('simulated interrupted write');
      values.set(key, structuredClone(value));
      if (fail?.(key, value, writes, true)) throw new Error('simulated lost response');
    },
    async remove(key) { values.delete(key); }
  };
  return { values, adapter, failWith(fn) { fail = fn; writes = 0; } };
}
function longInterview(segments = 1500) {
  const state = newState('aidol');
  state.topics.push(newTopic('host'));
  const s = current(state).session;
  for (let i = 0; i < segments; i++) {
    const seg = addSegment(s, `第 ${i} 段嘉宾原话：我们为社团整理报名信息，之前手动合并容易漏人。😀\\\"\n`.repeat(3), 'audio');
    seg.role = i % 2 ? 'host' : 'guest';
  }
  s.pendingAsr = [{ key: 'stream:pending', text: '尚待处理的中文回答' }];
  s.chapterSummaries = { project: '项目归纳与出处' };
  return state;
}
test('真实单项 64 KB 限制下保存并完整恢复 1500 段、多主题、归纳与待处理转写', async () => {
  const state = longInterview(), db = phoneStorage();
  assert.ok(Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024);
  await assert.rejects(db.adapter.set(KEY, state), /64 KB/); // 复现旧版失败。
  await createInterviewStore(db.adapter).save(state);
  assert.deepEqual(await createInterviewStore(db.adapter).load(), state);
  assert.equal(db.values.get(KEY).format, 'wenquan.chunked.v1');
});
test('中文、emoji、控制符、反斜线、引号和单独代理项跨分块仍可无损恢复', async () => {
  const state = newState('aidol');
  state.edge = '中😀\\\"\u0000\n\ud800\udfff'.repeat(20000);
  const db = phoneStorage();
  await createInterviewStore(db.adapter).save(state);
  assert.deepEqual(await createInterviewStore(db.adapter).load(), state);
});
test('旧版单项数据原样读入，迁移失败保留旧记录，重试后无损迁移', async () => {
  const old = newState('host'), next = longInterview(60), db = phoneStorage(old);
  const store = createInterviewStore(db.adapter);
  assert.deepEqual(await store.load(), old);
  db.failWith((key, _, n, after) => key !== KEY && n === 2 && !after);
  await assert.rejects(store.save(next), /interrupted/);
  assert.deepEqual(await createInterviewStore(db.adapter).load(), old);
  db.failWith(null);
  await store.save(next);
  assert.deepEqual(await createInterviewStore(db.adapter).load(), next);
});
test('任一分块或索引提交失败均可重启恢复上一份完整快照', async () => {
  for (const failAt of [1, 3, 'last', 'root']) {
    const old = longInterview(55), next = longInterview(90), db = phoneStorage();
    const store = createInterviewStore(db.adapter);
    await store.save(old);
    const lastChunk = Math.ceil(JSON.stringify(next).length / 8000);
    db.failWith((key, _, n, after) => !after && (failAt === 'root' ? key === KEY : n === (failAt === 'last' ? lastChunk : failAt)));
    await assert.rejects(store.save(next), /interrupted/);
    assert.deepEqual(await createInterviewStore(db.adapter).load(), old);
    db.failWith(null);
    await store.save(next);
    assert.deepEqual(await createInterviewStore(db.adapter).load(), next);
  }
});
test('索引已经提交但响应丢失时，重试重读有效分组，后续中断也不破坏已提交记录', async () => {
  const db = phoneStorage(), store = createInterviewStore(db.adapter);
  const a = newState('host'), b = longInterview(60), c = longInterview(90);
  await store.save(a);
  db.failWith((key, _, __, after) => key === KEY && after);
  await assert.rejects(store.save(b), /lost response/);
  assert.deepEqual(await createInterviewStore(db.adapter).load(), b);
  db.failWith((key, _, n, after) => key !== KEY && n === 2 && !after);
  await assert.rejects(store.save(c), /interrupted/);
  assert.deepEqual(await createInterviewStore(db.adapter).load(), b);
});
test('连续快速保存保持调用顺序，保存调用后的对象修改不污染快照', async () => {
  const db = phoneStorage(), store = createInterviewStore(db.adapter), state = newState('aidol');
  const first = store.save(state);
  state.note = '第二次';
  const second = store.save(state);
  state.note = '未保存的修改';
  await Promise.all([first, second]);
  assert.equal((await createInterviewStore(db.adapter).load()).note, '第二次');
});
test('两组快照轮换，删除主题后成功提交才清理旧尾块，不碰其他插件设置', async () => {
  const db = phoneStorage(), store = createInterviewStore(db.adapter), large = longInterview(80), small = newState('aidol');
  db.values.set('unrelated.setting', { keep: true });
  await store.save(large); await store.save(large);
  await store.save(small); await store.save(small);
  const count = db.values.get(KEY).count;
  assert.equal([...db.values.keys()].filter(k => k.startsWith(KEY + '.chunks.')).length, count * 2);
  assert.deepEqual(db.values.get('unrelated.setting'), { keep: true });
  assert.deepEqual(await createInterviewStore(db.adapter).load(), small);
});
test('缺块、同长度内容损坏及无效索引明确报错，不静默恢复成空记录', async () => {
  for (const kind of ['missing', 'checksum', 'index', 'unknown']) {
    const db = phoneStorage();
    await createInterviewStore(db.adapter).save(longInterview(60));
    const root = db.values.get(KEY), part = `${KEY}.chunks.${root.bank}.0`;
    if (kind === 'missing') db.values.delete(part);
    if (kind === 'checksum') db.values.set(part, 'x' + db.values.get(part).slice(1));
    if (kind === 'index') root.count = 0;
    if (kind === 'unknown') root.format = 'future-format';
    const before = structuredClone([...db.values]);
    await assert.rejects(createInterviewStore(db.adapter).load(), /未覆盖原记录/);
    assert.deepEqual([...db.values], before);
  }
});
