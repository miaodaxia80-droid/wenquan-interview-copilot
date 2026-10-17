export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
export const AUDIO_EXTENSIONS = ['ogg', 'wav', 'mp3', 'm4a', 'mp4', 'webm', 'flac'];
const utf8 = bytes => new TextDecoder().decode(bytes);

// 只检查容器头与尺寸，不宣称已经解码或识别；文件扩展名不作为格式依据。
export async function inspectAudio(blob) {
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error('音频文件为空。');
  if (blob.size > MAX_AUDIO_BYTES) throw new Error('音频超过 5 MiB，请先截取较短片段。');
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const text = utf8(bytes);
  let extension, mime;
  if (text.startsWith('OggS')) { extension = 'ogg'; mime = 'audio/ogg'; }
  else if (text.startsWith('RIFF') && text.slice(8, 12) === 'WAVE') { extension = 'wav'; mime = 'audio/wav'; }
  else if (text.startsWith('ID3') || bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0) { extension = 'mp3'; mime = 'audio/mpeg'; }
  else if (text.startsWith('fLaC')) { extension = 'flac'; mime = 'audio/flac'; }
  else if (text.slice(4, 8) === 'ftyp') { extension = 'm4a'; mime = 'audio/mp4'; }
  else if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) { extension = 'webm'; mime = 'audio/webm'; }
  else throw new Error('未识别到支持的音频容器，请选择 Ogg、WAV、MP3、M4A、WebM 或 FLAC。');
  return { extension, mime, filename: `interview.${extension}`, bytes: blob.size };
}

export async function readAudioStream(stream) {
  const reader = stream.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_AUDIO_BYTES) { await reader.cancel(); throw new Error('音频超过 5 MiB，请先截取较短片段。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const blob = new Blob(chunks), media = await inspectAudio(blob);
  return { blob: new Blob([blob], { type: media.mime }), media };
}
