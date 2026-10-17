import { createGMPlugin, opusRecordingToOgg } from './vendor/gm-plugin-web-sdk.esm.js';
export { opusRecordingToOgg };

function wrap(ctx, text, width) {
  const lines = []; let line = '';
  for (const char of text) {
    if (char === '\n' || ctx.measureText(line + char).width > width) { lines.push(line); line = char === '\n' ? '' : char; }
    else line += char;
  }
  if (line) lines.push(line);
  return lines;
}
export function drawHint(canvas, question, { paused = false, ended = false, demo = false } = {}) {
  canvas.width = 600; canvas.height = 350;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 600, 350);
  if (paused || ended) return;
  ctx.fillStyle = '#fff';
  ctx.font = '500 23px "PingFang SC", sans-serif';
  ctx.fillText(`问全  /  ${question ? '建议追问' : '等待对话'}`, 34, 52);
  ctx.fillStyle = '#999'; ctx.fillRect(34, 74, 532, 1);
  ctx.fillStyle = '#fff'; ctx.font = '500 34px "PingFang SC", sans-serif';
  const text = question?.text || '认真听，下一句慢慢问。';
  wrap(ctx, text, 518).slice(0, 4).forEach((line, i) => ctx.fillText(line, 34, 132 + i * 46));
  ctx.fillStyle = '#aaa'; ctx.font = '20px "PingFang SC", sans-serif';
  ctx.fillText(demo ? '离线脚本演示' : '由你决定是否追问', 34, 324);
}
export function gray4(rgba, width, height) {
  const stride = Math.ceil(width / 2), out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    const v = Math.round((rgba[p] * .2126 + rgba[p + 1] * .7152 + rgba[p + 2] * .0722) / 17);
    out[y * stride + (x >> 1)] |= v << (x % 2 ? 0 : 4);
  }
  return out;
}
const base64 = data => {
  let s = ''; for (const byte of data) s += String.fromCharCode(byte);
  return btoa(s);
};

export class GlassPresenter {
  constructor(gm, notify) { this.gm = gm; this.notify = notify; this.pending = null; this.running = null; this.closed = false; }
  close() { this.closed = true; this.pending = null; }
  present(canvas, clear = false) {
    if (this.closed) return Promise.resolve();
    // 捕获像素快照；最后一次意图优先，包括暂停时的清空。
    this.pending = clear ? { clear: true } : { pixels: canvas.getContext('2d').getImageData(0, 0, 600, 350).data };
    if (!this.running) {
      this.running = this.drain().finally(() => { this.running = null; });
    }
    return this.running;
  }
  async drain() {
    while (this.pending && !this.closed) {
      const next = this.pending; this.pending = null;
      try {
        if (next.clear) {
          const result = await this.gm.display.closePage();
          if (result?.closed !== true) throw new Error('设备没有确认清空');
        }
        else {
          const data = gray4(next.pixels, 600, 350);
          // 两块均低于 Scene Bridge 的 81,901 字节限制。
          for (let tile = 0; tile < 2; tile++) {
            if (this.closed) return;
            const result = await this.gm.display.updateImage({ x: 0, y: tile * 175, width: 600, height: 175, stride: 300, dataBase64: base64(data.subarray(tile * 52500, (tile + 1) * 52500)) });
            if (result?.presented !== true) throw new Error('设备没有确认显示');
          }
        }
        if (!this.closed) this.notify(next.clear ? '眼镜提示已清空' : '眼镜已确认显示', 'success');
      } catch (e) {
        if (!this.closed) this.notify(`眼镜未送达：${e.message || e.code || e}。手机仍可使用。`, 'error');
      }
    }
  }
}
export function connectBridge(onEvent) {
  const gm = createGMPlugin({ timeoutMs: 6000 });
  const off = [
    gm.on('device.connection', data => onEvent('connection', data)),
    gm.on('runtime.lifecycleChanged', data => onEvent('lifecycle', data))
  ];
  return { gm, close: () => { off.forEach(f => f()); gm.close(); } };
}
