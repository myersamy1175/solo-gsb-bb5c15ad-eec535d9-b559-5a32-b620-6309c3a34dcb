/**
 * 就地基-2 FFT 与旋转因子表缓存（STFT 会反复调用同尺寸 FFT）。
 * 供接缝频谱检查与重复片段发现共用。
 */

/** 每个 fftSize 的位反转表与旋转因子缓存 */
export interface FftTables {
  rev: Uint32Array;
  cos: Float32Array;
  sin: Float32Array;
}
const fftCache = new Map<number, FftTables>();

export function getFftTables(n: number): FftTables {
  const cached = fftCache.get(n);
  if (cached) return cached;
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 1; i < n; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    const a = (-2 * Math.PI * k) / n;
    cos[k] = Math.cos(a);
    sin[k] = Math.sin(a);
  }
  const tables: FftTables = { rev, cos, sin };
  fftCache.set(n, tables);
  return tables;
}

/** 就地基-2 FFT（re / im 长度 n，n 为 2 的幂） */
export function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  const { rev, cos, sin } = getFftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        const a = i + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}
