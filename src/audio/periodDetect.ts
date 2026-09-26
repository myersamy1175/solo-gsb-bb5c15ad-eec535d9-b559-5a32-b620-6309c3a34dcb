import type { AudioDataLike } from './types';

/**
 * 周期校准：将整段音频混合为单声道，提取短时能量变化包络，
 * 在可用音频范围内对「选区长度 1/2 ~ 2 倍」的滞后做归一化自相关，
 * 抑制整数倍 / 分频重复峰后给出前若干周期候选及置信度。
 *
 * - 包络：20 ms 帧（帧移 5 ms）的短时能量一阶差分（能量变化包络），
 *   突出响度的周期性起伏并去除直流与缓慢漂移。
 * - 自相关：每个滞后 τ 在可用范围 [0, N−τ) 内分别去均值做归一化
 *   （Pearson 形式），超出计算量预算时按步进抽样。
 * - 重复峰抑制：先做「基频优先」过滤——若某峰的整数分频处存在相关值
 *   相近（差值 ≤ 0.05）的峰，则该峰视为谐波重复被抑制（周期信号在整数倍
 *   滞后处的相关同样接近 1，不能仅凭相关值降序接受）；再按相关值降序贪心
 *   接受候选，与已接受滞后互为整数倍 / 整数分频（相对容差 3%）的重复峰被跳过。
 * - 置信度：峰值处的归一化自相关（抛物线插值后），截断到 [0, 1]。
 * - 短音频（包络不足以覆盖滞后范围）、静音（帧能量低于约 −80 dBFS）
 *   或无显著峰（最强峰低于 minCorrelation）时返回 failure 原因，
 *   调用方应提示原因并保留原选区，不得强制吸附。
 */

export interface PeriodDetectOptions {
  /** 能量帧长（秒），默认 0.02 */
  frameSec?: number;
  /** 帧移（秒），默认 frameSec / 4 */
  hopSec?: number;
  /** 最大候选数，默认 3 */
  maxCandidates?: number;
  /** 显著峰的最小归一化自相关，默认 0.3 */
  minCorrelation?: number;
  /** 整数倍 / 分频判定的相对容差，默认 0.03 */
  harmonicTolerance?: number;
  /** 每个滞后至少参与相关的包络帧数，默认 16 */
  minOverlapFrames?: number;
}

export interface PeriodCandidate {
  /** 周期（采样点，抛物线插值后的浮点值，吸附 / 定长搜索时取整） */
  periodSamples: number;
  /** 峰值处归一化自相关 [-1, 1] */
  correlation: number;
  /** 置信度 [0, 1]（归一化自相关的截断值） */
  confidence: number;
}

export type PeriodDetectFailure = 'too-short' | 'silence' | 'no-peak';

export interface PeriodDetectResult {
  /** 周期候选（按置信度降序，最多 maxCandidates 个） */
  candidates: PeriodCandidate[];
  /** 无候选时的原因；有候选时为 null */
  failure: PeriodDetectFailure | null;
  /** 能量变化包络帧数 */
  envelopeFrames: number;
  /** 帧移 / 帧长（采样点） */
  hopSamples: number;
  frameSamples: number;
  /** 实际搜索的滞后范围（采样点），无效时为 null */
  lagMinSamples: number | null;
  lagMaxSamples: number | null;
  /** 滞后范围内最强的局部峰相关值（无局部峰时为 0） */
  maxCorrelation: number;
}

/** 帧能量低于该值视为静音（峰值帧 RMS 约 −80 dBFS） */
const SILENCE_ENERGY = 1e-8;
/** 自相关总计算量预算（滞后 × 包络帧对数），超出则加大抽样步进 */
const PAIR_BUDGET = 16_000_000;
/** 基频优先判定：分频峰相关值与谐波峰相差不超过该值时，优先保留分频（更小周期） */
const FUNDAMENTAL_MARGIN = 0.05;

export function detectPeriods(
  audio: AudioDataLike,
  selStartSec: number,
  selEndSec: number,
  options: PeriodDetectOptions = {},
): PeriodDetectResult {
  const sr = audio.sampleRate;
  const len = audio.length;
  const frameSec = options.frameSec ?? 0.02;
  const frame = Math.max(64, Math.round(frameSec * sr));
  const hop = Math.max(16, Math.round((options.hopSec ?? frameSec / 4) * sr));
  const maxCandidates = Math.max(1, Math.round(options.maxCandidates ?? 3));
  const minCorr = options.minCorrelation ?? 0.3;
  const harmTol = options.harmonicTolerance ?? 0.03;
  const minOverlap = Math.max(4, Math.round(options.minOverlapFrames ?? 16));

  const base: PeriodDetectResult = {
    candidates: [],
    failure: null,
    envelopeFrames: 0,
    hopSamples: hop,
    frameSamples: frame,
    lagMinSamples: null,
    lagMaxSamples: null,
    maxCorrelation: 0,
  };

  const nFrames = Math.floor((len - frame) / hop) + 1;
  if (
    !Number.isFinite(selStartSec) ||
    !Number.isFinite(selEndSec) ||
    selEndSec - selStartSec <= 0 ||
    nFrames < minOverlap + 4
  ) {
    return { ...base, failure: 'too-short' };
  }

  // ---- 整段音频混合为单声道 ----
  const nCh = audio.numberOfChannels;
  const mono = new Float32Array(len);
  for (let c = 0; c < nCh; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i];
  }
  if (nCh > 1) {
    const inv = 1 / nCh;
    for (let i = 0; i < len; i++) mono[i] *= inv;
  }

  // ---- 短时能量 ----
  const energy = new Float64Array(nFrames);
  let maxE = 0;
  for (let f = 0; f < nFrames; f++) {
    const off = f * hop;
    let s = 0;
    for (let i = 0; i < frame; i++) {
      const x = mono[off + i];
      s += x * x;
    }
    const e = s / frame;
    energy[f] = e;
    if (e > maxE) maxE = e;
  }
  if (maxE < SILENCE_ENERGY) return { ...base, envelopeFrames: nFrames, failure: 'silence' };

  // ---- 能量变化包络（一阶差分）----
  const N = nFrames - 1;
  const env = new Float64Array(N);
  for (let f = 0; f < N; f++) env[f] = energy[f + 1] - energy[f];

  // ---- 滞后范围：选区长度的 1/2 ~ 2 倍（包络帧），限制在可用音频范围内 ----
  const selFrames = ((selEndSec - selStartSec) * sr) / hop;
  const lagMin = Math.max(1, Math.floor(selFrames / 2));
  const lagMax = Math.min(Math.ceil(selFrames * 2), N - minOverlap);
  if (lagMax < lagMin || lagMax < 2) {
    return { ...base, envelopeFrames: N, failure: 'too-short' };
  }

  // ---- 归一化自相关：每个滞后在可用范围 [0, N−τ) 内分别去均值 ----
  const nLags = lagMax - lagMin + 1;
  const strideCap = Math.max(1, Math.ceil((nLags * N) / PAIR_BUDGET));
  const corr = new Float64Array(nLags);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const n = N - lag;
    const st = Math.max(1, Math.min(strideCap, Math.floor(n / minOverlap)));
    let m1 = 0;
    let m2 = 0;
    let cnt = 0;
    for (let i = 0; i < n; i += st) {
      m1 += env[i];
      m2 += env[i + lag];
      cnt++;
    }
    if (cnt < 2) continue;
    m1 /= cnt;
    m2 /= cnt;
    let num = 0;
    let d1 = 0;
    let d2 = 0;
    for (let i = 0; i < n; i += st) {
      const a = env[i] - m1;
      const b = env[i + lag] - m2;
      num += a * b;
      d1 += a * a;
      d2 += b * b;
    }
    const den = Math.sqrt(d1 * d2);
    corr[lag - lagMin] = den > 0 ? num / den : 0;
  }

  // ---- 局部峰 + 抛物线插值（亚帧精度）；边界滞后允许单侧峰
  // （真实周期可能恰好落在 1/2 或 2 倍选区长度的边界上）----
  interface Peak {
    /** 滞后（包络帧，浮点） */
    lag: number;
    /** 峰值归一化自相关 */
    value: number;
  }
  const peaks: Peak[] = [];
  for (let k = 0; k < nLags; k++) {
    const c = corr[k];
    if (c <= 0) continue;
    const prev = k > 0 ? corr[k - 1] : -Infinity;
    const next = k < nLags - 1 ? corr[k + 1] : -Infinity;
    const isPeak = k === 0 ? c > next : k === nLags - 1 ? c > prev : c > prev && c >= next;
    if (!isPeak) continue;
    let lagF = lagMin + k;
    let value = c;
    if (k > 0 && k < nLags - 1) {
      const d = corr[k - 1] - 2 * c + corr[k + 1];
      if (d < 0) {
        const delta = (0.5 * (corr[k - 1] - corr[k + 1])) / d;
        lagF += delta;
        value = c - 0.25 * (corr[k - 1] - corr[k + 1]) * delta;
      }
    }
    peaks.push({ lag: lagF, value });
  }

  const diag = { ...base, envelopeFrames: N, lagMinSamples: lagMin * hop, lagMaxSamples: lagMax * hop };
  if (peaks.length === 0) return { ...diag, failure: 'no-peak' };
  peaks.sort((a, b) => b.value - a.value);

  // ---- 基频优先：整数倍滞后处的相关同样接近 1，若某峰的整数分频处
  // 存在相关值相近的峰，则该峰为谐波重复，优先保留更小周期 ----
  const tol = (lag: number) => Math.max(1, lag * harmTol);
  const fundamentals = peaks.filter((p) => {
    for (const q of peaks) {
      if (q === p || q.lag >= p.lag) continue;
      const k = Math.round(p.lag / q.lag);
      if (
        k >= 2 &&
        Math.abs(p.lag - k * q.lag) <= k * tol(q.lag) &&
        q.value >= p.value - FUNDAMENTAL_MARGIN
      ) {
        return false;
      }
    }
    return true;
  });

  const best = fundamentals[0];
  if (best.value < minCorr) {
    return { ...diag, failure: 'no-peak', maxCorrelation: best.value };
  }

  // ---- 抑制整数倍 / 分频重复峰：按相关值降序贪心接受（仅保留显著峰）----
  const accepted: Peak[] = [];
  for (const p of fundamentals) {
    if (p.value < minCorr) break;
    let related = false;
    for (const a of accepted) {
      // p ≈ k·a（k = 1 即重复峰，k ≥ 2 为整数倍）
      const kUp = Math.max(1, Math.round(p.lag / a.lag));
      if (Math.abs(p.lag - kUp * a.lag) <= kUp * tol(a.lag)) {
        related = true;
        break;
      }
      // a ≈ k·p（p 是已接受周期的分频）
      const kDown = Math.round(a.lag / p.lag);
      if (kDown >= 2 && Math.abs(a.lag - kDown * p.lag) <= kDown * tol(p.lag)) {
        related = true;
        break;
      }
    }
    if (related) continue;
    accepted.push(p);
    if (accepted.length >= maxCandidates) break;
  }

  return {
    ...diag,
    failure: null,
    maxCorrelation: best.value,
    candidates: accepted.map((p) => ({
      periodSamples: p.lag * hop,
      correlation: Math.min(1, Math.max(-1, p.value)),
      confidence: Math.min(1, Math.max(0, p.value)),
    })),
  };
}
