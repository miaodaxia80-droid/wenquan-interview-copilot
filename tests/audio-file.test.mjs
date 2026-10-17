import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectAudio, readAudioStream, MAX_AUDIO_BYTES } from '../web/audio-file.js';
test('音频格式由容器头判断，WAV 不会被改名成 Ogg', async () => {
  const wav = new Blob(['RIFF0000WAVEfmt '], { type: 'application/octet-stream' });
  assert.deepEqual(await inspectAudio(wav), { extension: 'wav', mime: 'audio/wav', filename: 'interview.wav', bytes: 16 });
  assert.equal((await inspectAudio(new Blob(['OggS000000000000']))).extension, 'ogg');
  assert.equal((await inspectAudio(new Blob(['ID30000000000000']))).extension, 'mp3');
  assert.equal((await inspectAudio(new Blob(['fLaC000000000000']))).extension, 'flac');
  assert.equal((await inspectAudio(new Blob(['0000ftypM4A 0000']))).extension, 'm4a');
  assert.equal((await inspectAudio(new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0])]))).extension, 'webm');
});
test('空文件、伪装音频和超限文件在发送之前被拒绝', async () => {
  await assert.rejects(inspectAudio(new Blob([])), /为空/);
  await assert.rejects(inspectAudio(new Blob(['<html>bad</html>'], { type: 'audio/ogg' })), /未识别/);
  await assert.rejects(inspectAudio(new Blob([new Uint8Array(MAX_AUDIO_BYTES + 1)])), /5 MiB/);
});
test('分块读取不会依赖宿主申报的大小，超限会取消流', async () => {
  const result = await readAudioStream(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('OggS1234')); c.enqueue(new Uint8Array([0, 0])); c.close(); } }));
  assert.equal(result.blob.size, 10); assert.equal(result.blob.type, 'audio/ogg');
  let cancelled = false;
  await assert.rejects(readAudioStream(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_AUDIO_BYTES + 1)); }, cancel() { cancelled = true; } })), /5 MiB/);
  assert.equal(cancelled, true);
});
