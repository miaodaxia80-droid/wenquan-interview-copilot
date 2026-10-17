// 增量封装原生 20 ms Opus 帧；音频字节不经过 Base64 或页面持久化。
const encoder = new TextEncoder();
export function oggPage(packet, granule, serial, sequence, flags = 0) {
  const lacing = [];
  if (packet) { let remaining = packet.length; while (remaining >= 255) { lacing.push(255); remaining -= 255; } lacing.push(remaining); }
  if (lacing.length > 255) throw new Error('Opus 帧超出 Ogg 页面限制。');
  const bytes = new Uint8Array(27 + lacing.length + (packet?.length || 0)), view = new DataView(bytes.buffer);
  bytes.set(encoder.encode('OggS')); bytes[5] = flags;
  view.setUint32(6, granule >>> 0, true); view.setUint32(10, Math.floor(granule / 0x100000000), true);
  view.setUint32(14, serial, true); view.setUint32(18, sequence, true); bytes[26] = lacing.length;
  bytes.set(lacing, 27); if (packet) bytes.set(packet, 27 + lacing.length);
  let crc = 0;
  for (const byte of bytes) { crc ^= byte << 24; for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0)) >>> 0; }
  view.setUint32(22, crc, true); return bytes;
}
const concat = pages => { const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0)); let offset = 0; for (const p of pages) { out.set(p, offset); offset += p.length; } return out; };
export class OpusOggStream {
  constructor(serial = crypto.getRandomValues(new Uint32Array(1))[0]) { this.serial = serial; this.sequence = 0; this.frames = 0; this.ended = false; }
  headers() {
    const head = new Uint8Array(19), view = new DataView(head.buffer); head.set(encoder.encode('OpusHead')); head[8] = 1; head[9] = 1;
    view.setUint16(10, 312, true); view.setUint32(12, 16000, true);
    const vendor = encoder.encode('Wenquan streaming'), tags = new Uint8Array(16 + vendor.length);
    tags.set(encoder.encode('OpusTags')); new DataView(tags.buffer).setUint32(8, vendor.length, true); tags.set(vendor, 12);
    return concat([oggPage(head, 0, this.serial, this.sequence++, 2), oggPage(tags, 0, this.serial, this.sequence++)]);
  }
  push(chunk) {
    if (this.ended) throw new Error('音频封装已结束。');
    if (chunk.discontinuity || chunk.droppedFrameCount) throw new Error('采集发生音频丢帧，请停止后重新录音；已有文字保留。');
    if (!(chunk.data instanceof Uint8Array) || !Array.isArray(chunk.frameLengths) || !chunk.frameLengths.length) throw new Error('Opus 音频帧无效。');
    let offset = 0;
    for (const length of chunk.frameLengths) { if (!Number.isInteger(length) || length < 1 || length > 1275) throw new Error('Opus 帧长度无效。'); offset += length; }
    if (offset !== chunk.data.length) throw new Error('Opus 数据与帧边界不匹配。');
    offset = 0;
    return concat(chunk.frameLengths.map(length => { const packet = chunk.data.subarray(offset, offset + length); offset += length; this.frames++; return oggPage(packet, this.frames * 960, this.serial, this.sequence++); }));
  }
  end() { if (this.ended) return new Uint8Array(); this.ended = true; return oggPage(null, this.frames * 960, this.serial, this.sequence++, 4); }
}
