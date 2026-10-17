import { gzipSync, gunzipSync } from 'node:zlib';
export const PLAN_ASR_URL = 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async';
export function encodeRequest(type, sequence, data, last = false) {
  const payload = gzipSync(type === 1 ? Buffer.from(JSON.stringify(data)) : Buffer.from(data));
  const out = Buffer.alloc(12 + payload.length);
  out[0] = 0x11; out[1] = (type << 4) | (last ? 3 : 1); out[2] = (type === 1 ? 0x10 : 0) | 1;
  out.writeInt32BE(last ? -sequence : sequence, 4); out.writeUInt32BE(payload.length, 8); payload.copy(out, 12); return out;
}
export function decodeResponse(input) {
  const b = Buffer.from(input);
  if (b.length < 8 || b[0] >> 4 !== 1) throw new Error('语音响应协议头无效。');
  const type = b[1] >> 4, flags = b[1] & 15, serialization = b[2] >> 4, compression = b[2] & 15;
  let offset = (b[0] & 15) * 4;
  const read = () => { if (offset + 4 > b.length) throw new Error('语音响应被截断。'); const v = b.readInt32BE(offset); offset += 4; return v; };
  if (offset < 4 || offset > b.length) throw new Error('语音响应协议头长度无效。');
  let sequence;
  if (flags & 1) sequence = read();
  if (flags & 4) read();
  const code = type === 15 ? read() : 0;
  if (![9, 15].includes(type)) throw new Error('语音响应类型无效。');
  const size = read();
  if (size < 0 || offset + size !== b.length) throw new Error('语音响应长度不匹配。');
  let payload = b.subarray(offset);
  if (compression === 1) payload = gunzipSync(payload, { maxOutputLength: 1024 * 1024 });
  else if (compression !== 0) throw new Error('不支持的语音响应压缩方式。');
  const data = serialization === 1 && payload.length ? JSON.parse(payload.toString('utf8')) : { message: payload.toString('utf8') };
  return { code, sequence, last: !!(flags & 2), data };
}
export function asrRequest(audio) {
  if (!audio || !['pcm', 'wav', 'ogg'].includes(audio.format) || audio.rate !== 16000 || audio.channel !== 1 || (audio.format === 'ogg' ? audio.codec !== 'opus' : audio.codec !== 'raw')) throw new Error('流式音频须为 16 kHz 单声道 PCM/WAV 或 Ogg Opus。');
  return { user: { uid: 'wenquan-local' }, audio: { ...audio, bits: 16 }, request: { model_name: 'bigmodel', enable_itn: false, enable_punc: true, enable_ddc: false, show_utterances: true, enable_nonstream: true, enable_speaker_info: true, ssd_version: '200' } };
}
export function safeAsrError(error, key = '') {
  let message = String(error?.message || error || '语音识别连接失败');
  if (key) message = message.split(key).join('[redacted]');
  return message.replace(/(?:Bearer\s+\S+|(?:sk|pk)-[\w-]{8,})/gi, '[redacted]').replace(/[\r\n]+/g, ' ').slice(0, 200);
}
