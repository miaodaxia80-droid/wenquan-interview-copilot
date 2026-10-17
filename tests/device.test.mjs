import test from 'node:test';
import assert from 'node:assert/strict';
import { GlassPresenter, gray4 } from '../dist/device.js';

const fakeCanvas = value => ({ getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(600 * 350 * 4).fill(value) }) }) });
test('GRAY4 保持高低半字节顺序和奇数宽度行距', () => {
  const pixels = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 136, 136, 136, 255]);
  assert.deepEqual([...gray4(pixels, 3, 1)], [0xf0, 0x80]);
});
test('显示分块低于传输上限，暂停清空排在正在传输的旧帧之后', async () => {
  const calls = []; let release;
  const barrier = new Promise(resolve => release = resolve);
  const gm = { display: {
    async updateImage(options) { calls.push(options); if (calls.length === 1) await barrier; return { presented: true }; },
    async closePage() { calls.push('clear'); return { closed: true }; }
  } };
  const presenter = new GlassPresenter(gm, () => {});
  const running = presenter.present(fakeCanvas(255));
  presenter.present(fakeCanvas(0)); presenter.present(fakeCanvas(0), true); release(); await running;
  assert.equal(calls.length, 3); assert.equal(calls.at(-1), 'clear');
  for (const call of calls.slice(0, 2)) assert.ok(Buffer.from(call.dataBase64, 'base64').length + 10 < 81901);
});
test('断连或权限拒绝不会报送达，并可恢复后重试', async () => {
  const messages = []; let deny = true;
  const gm = { display: { async updateImage() { if (deny) throw new Error('PERMISSION_DENIED'); return { presented: true }; } } };
  const presenter = new GlassPresenter(gm, message => messages.push(message));
  await presenter.present(fakeCanvas(255)); assert.match(messages.at(-1), /未送达/);
  deny = false; await presenter.present(fakeCanvas(255)); assert.match(messages.at(-1), /已确认显示/);
});
test('没有显示确认不能报告成功，运行代际关闭后不再发旧帧', async () => {
  const messages = [], calls = []; let release;
  const presenter = new GlassPresenter({ display: { async updateImage() { return { presented: false }; } } }, m => messages.push(m));
  await presenter.present(fakeCanvas(255)); assert.match(messages.at(-1), /未送达/);
  const barrier = new Promise(resolve => release = resolve);
  const closing = new GlassPresenter({ display: { async updateImage() { calls.push('tile'); await barrier; return { presented: true }; } } }, () => {});
  const running = closing.present(fakeCanvas(255)); closing.close(); release(); await running;
  await closing.present(fakeCanvas(255)); assert.deepEqual(calls, ['tile']);
});
