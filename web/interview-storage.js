// 手机宿主单项上限为 64 KB。一个 UTF-16 单元 JSON 编码至多占 6 字节，
// 8000 单元即使遇到转义字符、中文或分开的代理对，也低于 48 KB。
const CHUNK_UNITS = 8000;
const FORMAT = 'wenquan.chunked.v1';
const MAX_CHUNKS = 10000;
function checksum(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
function manifest(value) {
  if (value?.format !== FORMAT) {
    if (value && value.schema !== 1) throw new Error('保存的记录格式不兼容；未覆盖原记录。');
    return null; // 旧版本的整份 JSON，下一次成功保存时迁移。
  }
  if (![0, 1].includes(value.bank) || !Number.isInteger(value.count) || value.count < 1 || value.count > MAX_CHUNKS ||
      !Number.isInteger(value.length) || value.length < 1 || Math.ceil(value.length / CHUNK_UNITS) !== value.count ||
      typeof value.checksum !== 'string' || !Array.isArray(value.bankCounts) || value.bankCounts.length !== 2 ||
      value.bankCounts.some(n => !Number.isInteger(n) || n < 0 || n > MAX_CHUNKS) || value.bankCounts[value.bank] !== value.count) {
    throw new Error('访谈存储索引损坏；未覆盖原记录，请先保留备份。');
  }
  return value;
}

// adapter.get 返回存储值本身。只操作本记录的分块，不调用 storage.clear。
export function createInterviewStore(adapter, key = 'wenquan.interviews.v1') {
  let metadata, queue = Promise.resolve();
  const partKey = (bank, index) => `${key}.chunks.${bank}.${index}`;
  async function readRoot() {
    const root = await adapter.get(key);
    metadata = { root, info: manifest(root) };
    return metadata;
  }
  async function load() {
    const { root, info } = await readRoot();
    if (!info) return root;
    const parts = [];
    for (let i = 0; i < info.count; i++) {
      const part = await adapter.get(partKey(info.bank, i));
      if (typeof part !== 'string' || part.length !== Math.min(CHUNK_UNITS, info.length - i * CHUNK_UNITS)) {
        throw new Error('访谈记录分块缺失或损坏；未覆盖原记录，请先保留备份。');
      }
      parts.push(part);
    }
    const text = parts.join('');
    if (checksum(text) !== info.checksum) throw new Error('访谈记录校验失败；未覆盖原记录，请先保留备份。');
    try { return JSON.parse(text); }
    catch { throw new Error('访谈记录内容损坏；未覆盖原记录，请先保留备份。'); }
  }
  async function write(text) {
    const count = Math.ceil(text.length / CHUNK_UNITS);
    if (count > MAX_CHUNKS) throw new Error('访谈记录过大，请先导出备份。');
    const { info } = metadata || await readRoot();
    const bank = info ? 1 - info.bank : 0;
    const counts = info ? [...info.bankCounts] : [0, 0];
    try {
      // 先写另一组完整数据，最后一次 set 才切换索引。中断不会破坏当前快照。
      for (let i = 0; i < count; i++) await adapter.set(partKey(bank, i), text.slice(i * CHUNK_UNITS, (i + 1) * CHUNK_UNITS));
      const next = { format: FORMAT, bank, count, length: text.length, checksum: checksum(text), bankCounts: [...counts] };
      next.bankCounts[bank] = count;
      await adapter.set(key, next);
      metadata = { root: next, info: next };
    } catch (error) {
      // 宿主可能已写入索引但丢失响应。重试前重读，避免误写当前有效分组。
      metadata = undefined;
      throw error;
    }
    // 只在提交成功后回收此分组旧尾块；回收失败不把已保存误报为失败。
    if (adapter.remove) for (let i = count; i < counts[bank]; i++) {
      try { await adapter.remove(partKey(bank, i)); } catch { break; }
    }
  }
  return {
    load,
    save(value) {
      const text = JSON.stringify(value);
      const pending = queue.catch(() => {}).then(() => write(text));
      queue = pending;
      return pending;
    }
  };
}
