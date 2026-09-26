import type { PcmBuffer } from './types';

/**
 * WAV 导出：16-bit little-endian PCM，并写入 smpl 区块标记整段为循环
 * （循环起点 0，终点为最后一帧），采样器/DAW 打开即可无缝循环。
 */

const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
/** smpl 区块：36 字节头部 + 每个循环 24 字节（本工具只写 1 个循环） */
const SMPL_SIZE = 36 + 24;

/** 估算导出文件的总字节数（含 RIFF / fmt / smpl / data 各区块）。 */
export function wavFileSize(frames: number, channels: number): number {
  const dataSize = frames * channels * BYTES_PER_SAMPLE;
  return (
    12 + // RIFF 头（"RIFF" + size + "WAVE"）
    8 + 16 + // fmt 区块
    8 + SMPL_SIZE + // smpl 区块
    8 + dataSize + (dataSize % 2) // data 区块（奇数字节需补 1 字节对齐）
  );
}

/** 把循环 PCM 编码为完整 WAV 文件字节。多声道按帧交错，浮点先夹取到 [-1,1] 再量化。 */
export function encodeWav(pcm: PcmBuffer): ArrayBuffer {
  const channels = pcm.channels.length;
  const frames = pcm.channels[0]?.length ?? 0;
  const dataSize = frames * channels * BYTES_PER_SAMPLE;
  const buf = new ArrayBuffer(wavFileSize(frames, channels));
  const v = new DataView(buf);
  let o = 0;

  const writeAscii = (s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i));
  };
  const u32 = (n: number) => {
    v.setUint32(o, n, true);
    o += 4;
  };
  const u16 = (n: number) => {
    v.setUint16(o, n, true);
    o += 2;
  };

  // ---- RIFF 头 ----
  writeAscii('RIFF');
  u32(buf.byteLength - 8);
  writeAscii('WAVE');

  // ---- fmt 区块：PCM / 16-bit ----
  writeAscii('fmt ');
  u32(16);
  u16(1); // PCM
  u16(channels);
  u32(pcm.sampleRate);
  u32(pcm.sampleRate * channels * BYTES_PER_SAMPLE); // byteRate
  u16(channels * BYTES_PER_SAMPLE); // blockAlign
  u16(BITS_PER_SAMPLE);

  // ---- smpl 区块：整段 [0, frames-1] 为前向循环 ----
  writeAscii('smpl');
  u32(SMPL_SIZE);
  u32(0); // manufacturer
  u32(0); // product
  u32(Math.round(1e9 / pcm.sampleRate)); // 每帧周期（纳秒）
  u32(60); // MIDI 基准音高
  u32(0); // 音高微调
  u32(0); // SMPTE 格式
  u32(0); // SMPTE 偏移
  u32(1); // 循环数量
  u32(0); // 附加采样器数据
  u32(0); // 循环 ID
  u32(0); // 类型：前向循环
  u32(0); // 循环起点（帧）
  u32(frames - 1); // 循环终点：最后一帧
  u32(0); // 微调
  u32(0); // 播放次数：无限

  // ---- data 区块：按帧交错、夹取后量化为 int16 ----
  writeAscii('data');
  u32(dataSize);
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const x = Math.max(-1, Math.min(1, pcm.channels[ch][i]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
  }
  return buf;
}
