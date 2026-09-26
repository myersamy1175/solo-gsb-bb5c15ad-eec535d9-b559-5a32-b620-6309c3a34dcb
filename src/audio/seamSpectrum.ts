import { fftInPlace } from './fft';
import type { PcmBuffer } from './types';

/**
 * 接缝频谱检查：对循环 PCM（buildLoopPcm 的输出，与试听 / 导出口径一致）
 * 的尾部与头部各取相同长度片段，按重叠 Hann 窗做 STFT，
 * 比较对应时间帧（按与接缝的距离配对）的对数频带能量差。
 *
 * - 频带：minFreqHz ~ Nyquist 之间等比划分（默认 8 个对数频带），
 *   低于 minFreqHz 的 bin（含直流）不计入任何频带。
 * - 帧配对：头部第 j 帧 ↔ 尾部倒数第 j 帧，即两者与接缝的距离相等，
 *   热图横轴为「帧中心距接缝的时间」。
 * - 数值安全：频带能量下限取「该帧总能量 −90 dB」与绝对下限（约 −120 dB）
 *   的较大者（能量为 NaN 时同样回落到下限），静音频带得到有限值，
 *   差值矩阵保证不出现 NaN / Infinity。
 */

export interface SeamSpectrumOptions {
  /** 对数频带数量，默认 8 */
  bands?: number;
  /** 最低频带边缘 Hz，默认 40 */
  minFreqHz?: number;
}

export interface SeamSpectrumResult {
  /** 采样率 Hz */
  sampleRate: number;
  /** 频带数量 */
  bands: number;
  /** 频带边缘频率 Hz（bands + 1 个） */
  bandEdgesHz: number[];
  /** 频带中心频率 Hz（几何平均，bands 个） */
  bandCentersHz: number[];
  /** FFT 大小（采样点，2 的幂） */
  fftSize: number;
  /** 帧移（采样点），固定为 fftSize / 4（75% 重叠） */
  hopSamples: number;
  /** 每帧中心距接缝的时间（秒，近似值，误差 < 1 个 hop） */
  frameOffsetsSec: number[];
  /**
   * 能量差热图 diffDb[frame][band]（dB）：
   * 头部帧能量 − 配对的尾部帧能量，正值表示循环头部该频带更响。
   * 全部为有限值（静音频带不会出现 NaN / Infinity）。
   */
  diffDb: number[][];
  /** 每个频带全帧的最大绝对差（dB） */
  bandMaxAbsDb: number[];
  /** 全局最大绝对差（dB） */
  maxAbsDiffDb: number;
  /** 最差频带索引（bandMaxAbsDb 最大者） */
  worstBand: number;
  /** 实际使用的检查窗长度（采样点，夹取后） */
  windowSamples: number;
  /** 请求窗长是否因超过循环长度一半而被夹取 */
  clamped: boolean;
}

/** 频带能量下限：约 −120 dB，避免静音时取对数得到 −Infinity */
const EPS = 1e-12;

/**
 * 计算片段 [from, from+win) 的 STFT 频带能量（dB），返回 energies[frame][band]。
 * 多声道按频带能量取平均；帧长不足 fftSize 时零填充（仅循环极短时出现）。
 */
function segmentBandDb(
  pcm: PcmBuffer,
  from: number,
  win: number,
  fftSize: number,
  hop: number,
  frameCount: number,
  hann: Float32Array,
  binBand: Int16Array,
  bands: number,
): number[][] {
  const nCh = pcm.channels.length;
  const acc: Float64Array[] = [];
  for (let f = 0; f < frameCount; f++) acc.push(new Float64Array(bands));
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  for (let ch = 0; ch < nCh; ch++) {
    const data = pcm.channels[ch];
    for (let f = 0; f < frameCount; f++) {
      const off = from + f * hop;
      const n = Math.min(fftSize, win - f * hop);
      re.fill(0);
      im.fill(0);
      for (let i = 0; i < n; i++) re[i] = data[off + i] * hann[i];
      fftInPlace(re, im);
      const row = acc[f];
      for (let k = 1; k <= fftSize / 2; k++) {
        const b = binBand[k];
        if (b < 0) continue;
        row[b] += re[k] * re[k] + im[k] * im[k];
      }
    }
  }
  return acc.map((row) => {
    let total = 0;
    for (let b = 0; b < bands; b++) total += row[b] / nCh;
    // 动态下限：帧总能量的 −90 dB（静音或异常时回落到绝对下限 EPS）。
    // 远离信号能量的频带被钉在下限上，两侧同时触限时差值为 0，
    // 避免浮点噪声在无用频带上产生虚假的巨大差值。
    const rel = total * 1e-9;
    const floor = rel > EPS ? rel : EPS;
    return Array.from(row, (e) => {
      const avg = e / nCh;
      const safe = avg > floor ? avg : floor;
      return 10 * Math.log10(safe);
    });
  });
}

/**
 * 分析循环 PCM 的接缝频谱连续性。
 *
 * @param pcm 循环 PCM（buildLoopPcm 的输出，含交叉淡化）
 * @param requestedWindowSamples 请求的检查窗长度（采样点），
 *   超过循环长度一半时自动夹取（clamped = true）
 * @returns 循环太短（< 32 采样点）或参数非法时返回 null
 */
export function analyzeSeamSpectrum(
  pcm: PcmBuffer,
  requestedWindowSamples: number,
  options: SeamSpectrumOptions = {},
): SeamSpectrumResult | null {
  const nCh = pcm.channels.length;
  const L = pcm.channels[0]?.length ?? 0;
  const sr = pcm.sampleRate;
  if (nCh === 0 || L < 32 || !Number.isFinite(sr) || sr <= 0) return null;
  if (!Number.isFinite(requestedWindowSamples) || requestedWindowSamples <= 0) return null;

  const bands = Math.max(2, Math.round(options.bands ?? 8));

  // ---- 检查窗：尾部 / 头部各取 win 个采样点，夹取到循环长度的一半 ----
  const requested = Math.round(requestedWindowSamples);
  const maxWin = Math.floor(L / 2);
  const win = Math.max(16, Math.min(requested, maxWin));
  const clamped = requested > maxWin;

  // ---- STFT 参数：fftSize 为不超过 win 的 2 的幂（64 ~ 2048），75% 重叠 ----
  let fftSize = 64;
  while (fftSize * 2 <= win && fftSize < 2048) fftSize <<= 1;
  const hop = Math.max(1, fftSize >> 2);
  const frameCount = win >= fftSize ? Math.floor((win - fftSize) / hop) + 1 : 1;

  const hann = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
  }

  // ---- 对数频带：minFreqHz ~ Nyquist 等比划分 ----
  const nyq = sr / 2;
  const fMin = Math.max(1, Math.min(options.minFreqHz ?? 40, nyq / 2));
  const bandEdgesHz: number[] = [];
  for (let b = 0; b <= bands; b++) {
    bandEdgesHz.push(fMin * Math.pow(nyq / fMin, b / bands));
  }
  const bandCentersHz: number[] = [];
  for (let b = 0; b < bands; b++) {
    bandCentersHz.push(Math.sqrt(bandEdgesHz[b] * bandEdgesHz[b + 1]));
  }

  // 每个 FFT bin 归属的频带（-1 = 低于 minFreqHz，含直流，不计入）
  const binBand = new Int16Array(fftSize / 2 + 1).fill(-1);
  const logRatio = Math.log(nyq / fMin);
  for (let k = 1; k <= fftSize / 2; k++) {
    const f = (k * sr) / fftSize;
    if (f < fMin || f > nyq) continue;
    binBand[k] = Math.min(bands - 1, Math.floor((bands * Math.log(f / fMin)) / logRatio));
  }

  // ---- 尾部 / 头部片段的 STFT 频带能量 ----
  const headDb = segmentBandDb(pcm, 0, win, fftSize, hop, frameCount, hann, binBand, bands);
  const tailDb = segmentBandDb(pcm, L - win, win, fftSize, hop, frameCount, hann, binBand, bands);

  // ---- 帧配对：头部第 j 帧 ↔ 尾部倒数第 j 帧（与接缝等距），差值 = 头 − 尾 ----
  const diffDb: number[][] = [];
  const frameOffsetsSec: number[] = [];
  const bandMaxAbsDb = new Array<number>(bands).fill(0);
  let maxAbsDiffDb = 0;
  let worstBand = 0;
  for (let j = 0; j < frameCount; j++) {
    const tailRow = tailDb[frameCount - 1 - j];
    const headRow = headDb[j];
    const row: number[] = [];
    for (let b = 0; b < bands; b++) {
      const d = headRow[b] - tailRow[b];
      row.push(d);
      const a = Math.abs(d);
      if (a > bandMaxAbsDb[b]) bandMaxAbsDb[b] = a;
    }
    diffDb.push(row);
    frameOffsetsSec.push((j * hop + fftSize / 2) / sr);
  }
  for (let b = 0; b < bands; b++) {
    if (bandMaxAbsDb[b] > maxAbsDiffDb) {
      maxAbsDiffDb = bandMaxAbsDb[b];
      worstBand = b;
    }
  }

  return {
    sampleRate: sr,
    bands,
    bandEdgesHz,
    bandCentersHz,
    fftSize,
    hopSamples: hop,
    frameOffsetsSec,
    diffDb,
    bandMaxAbsDb,
    maxAbsDiffDb,
    worstBand,
    windowSamples: win,
    clamped,
  };
}
