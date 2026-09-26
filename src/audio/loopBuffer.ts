import type { AudioDataLike, PcmBuffer } from './types';

/**
 * 把 [startSample, endSample) 区间构造成可无缝循环的 PCM。
 *
 * 交叉淡化构造（等功率）：设循环体长度 L = end − start，淡化长度 N。
 *   y[0 .. L−N)   = x[start+N .. end)                —— 循环体前移 N 个采样
 *   y[L−N+k]      = x[end−N+k]·cos θ + x[start+k]·sin θ,  θ = (k+0.5)/N · π/2
 *
 * 这样循环回绕处 y[L−1] ≈ x[start+N−1] 与 y[0] = x[start+N] 自然衔接，
 * 得到的缓冲区可直接以 loop=true 播放而无爆音。
 */
export function buildLoopPcm(
  source: AudioDataLike,
  startSample: number,
  endSample: number,
  crossfadeSamples: number,
): PcmBuffer {
  const len = source.length;
  const s = Math.max(0, Math.min(Math.round(startSample), len - 2));
  const e = Math.max(s + 2, Math.min(Math.round(endSample), len));
  const L = e - s;
  const N = Math.max(0, Math.min(Math.round(crossfadeSamples), Math.floor(L / 2)));

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    const src = source.getChannelData(ch);
    const dst = new Float32Array(L);
    const bodyEnd = L - N;
    for (let i = 0; i < bodyEnd; i++) dst[i] = src[s + N + i];
    for (let k = 0; k < N; k++) {
      const t = (k + 0.5) / N;
      const angle = (t * Math.PI) / 2;
      const gOut = Math.cos(angle);
      const gIn = Math.sin(angle);
      dst[bodyEnd + k] = src[e - N + k] * gOut + src[s + k] * gIn;
    }
    channels.push(dst);
  }
  return { sampleRate: source.sampleRate, channels };
}
