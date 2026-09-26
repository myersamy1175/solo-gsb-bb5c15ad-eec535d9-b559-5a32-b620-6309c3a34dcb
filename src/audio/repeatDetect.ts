import { fftInPlace } from './fft';
import type { AudioDataLike } from './types';

/**
 * 重复片段发现：对已解码音频提取固定步长的多频带能量特征，
 * 构建跨时间自相似匹配（逐对角线的帧间余弦相似度），沿对角线合并连续命中，
 * 过滤自匹配 / 区间重叠 / 过短段落后给出最多若干组重复片段。
 *
 * - 特征：整段音频混合为单声道，Hann 窗 STFT，minFreqHz ~ Nyquist 等比划分的
 *   对数频带能量（dB，动态下限，与接缝频谱检查口径一致）；逐频带减去全曲均值
 *   （去除整体响度与频谱形状的共性成分），帧向量做 L2 归一化，
 *   帧间相似度 = 余弦相似度。帧移在单次分析内固定；长音频按比例加大帧移
 *   以把总帧数限制在 maxFrames 以内，控制自相似匹配的计算量。
 * - 匹配：对每个滞后 d（相似矩阵的一条对角线）计算 sim(t, t+d)，
 *   连续 ≥ minSimilarity 的命中沿对角线合并为一次重复，
 *   允许 ≤ maxGapFrames 帧的短暂断裂（弱命中不切断段落）。
 * - 过滤：滞后 d 小于最短段落帧数的对角线不扫描（d → 0 即自匹配，
 *   且 d 小于段长时两区间必然重叠）；命中段长度 > d 时夹取为 d
 *   （A、B 首尾相接，互不重叠）；段落时长不足 minSegmentSec 的命中被丢弃。
 * - 去重：候选按相似度降序贪心接受，两个区间起点均相距不足 dedupSec 的
 *   视为同一重复被跳过，最多保留 maxGroups 组。
 * - 静音帧（帧能量低于约 −80 dBFS）不参与匹配；整段静音、特征帧不足
 *   （无法容纳两个最短段落）或无可靠命中时返回 failure 原因，
 *   调用方应提示空状态且不得改变当前选区。
 */

export interface RepeatDetectOptions {
  /** 分析窗长（秒），默认 0.046（≈2048 采样点 @ 44.1 kHz） */
  frameSec?: number;
  /** 特征帧移（秒，单次分析内固定），默认 0.015；长音频自动加大以限制总帧数 */
  hopSec?: number;
  /** 最大特征帧数（超出时按比例加大帧移），默认 8000 */
  maxFrames?: number;
  /** 对数频带数量，默认 8 */
  bands?: number;
  /** 最低频带边缘 Hz，默认 40 */
  minFreqHz?: number;
  /** 命中的最小余弦相似度，默认 0.9 */
  minSimilarity?: number;
  /** 最短段落时长（秒），默认 0.5 */
  minSegmentSec?: number;
  /** 沿对角线合并时允许的最大断裂（帧），默认 2 */
  maxGapFrames?: number;
  /** 去重阈值（秒）：两组候选的两个区间起点均相距不足该值时视为同一重复，默认 0.15 */
  dedupSec?: number;
  /** 最多返回的组数，默认 5 */
  maxGroups?: number;
}

export interface RepeatMatch {
  /** 较早区间起点 / 终点（采样点，终点不含） */
  aStartSample: number;
  aEndSample: number;
  /** 较晚区间起点 / 终点（采样点，终点不含）；与较早区间等长且互不重叠 */
  bStartSample: number;
  bEndSample: number;
  /** 段落内命中帧的平均余弦相似度 [0, 1] */
  similarity: number;
}

export type RepeatDetectFailure = 'too-short' | 'silence' | 'no-match';

export interface RepeatDetectResult {
  /** 重复片段组（按相似度降序，最多 maxGroups 组） */
  groups: RepeatMatch[];
  /** 无可靠结果时的原因；有结果时为 null */
  failure: RepeatDetectFailure | null;
  /** 特征帧数 */
  featureFrames: number;
  /** 帧移 / 窗长（采样点） */
  hopSamples: number;
  frameSamples: number;
  /** 频带数量 */
  bands: number;
}

/** 帧能量低于该值视为静音（帧 RMS 约 −80 dBFS） */
const SILENCE_ENERGY = 1e-8;
/** 频带能量下限：约 −120 dB，避免静音时取对数得到 −Infinity */
const EPS = 1e-12;

export function detectRepeats(
  audio: AudioDataLike,
  options: RepeatDetectOptions = {},
): RepeatDetectResult {
  const sr = audio.sampleRate;
  const len = audio.length;
  const nCh = audio.numberOfChannels;
  const bands = Math.max(2, Math.round(options.bands ?? 8));
  const minSim = options.minSimilarity ?? 0.9;
  const minSegSec = options.minSegmentSec ?? 0.5;
  const maxGap = Math.max(0, Math.round(options.maxGapFrames ?? 2));
  const maxGroups = Math.max(1, Math.round(options.maxGroups ?? 5));
  const dedupSec = options.dedupSec ?? 0.15;
  const maxFrames = Math.max(200, Math.round(options.maxFrames ?? 8000));

  // ---- 窗长：最接近 frameSec 的 2 的幂（256 ~ 4096）----
  const wantFrame = (options.frameSec ?? 0.046) * sr;
  let frame = 256;
  while (frame * 2 <= wantFrame * 1.5 && frame < 4096) frame <<= 1;

  // ---- 帧移：固定步长；长音频按比例加大以限制总帧数 ----
  const baseHop = Math.max(1, Math.round((options.hopSec ?? 0.015) * sr));
  const hop = Math.max(baseHop, Math.ceil(len / maxFrames));

  const base: RepeatDetectResult = {
    groups: [],
    failure: null,
    featureFrames: 0,
    hopSamples: hop,
    frameSamples: frame,
    bands,
  };

  if (
    !Number.isFinite(sr) ||
    sr <= 0 ||
    nCh <= 0 ||
    !Number.isFinite(minSegSec) ||
    minSegSec <= 0
  ) {
    return { ...base, failure: 'too-short' };
  }

  const nFrames = Math.floor((len - frame) / hop) + 1;
  // 最短段落（帧）；滞后小于该值即自匹配 / 必然重叠，不作为对角线扫描
  const minSegFrames = Math.max(2, Math.ceil((minSegSec * sr) / hop));
  // 对角线 d 上需要至少 minSegFrames 个帧位置：d ∈ [minSegFrames, nFrames − minSegFrames]
  if (nFrames < 2 * minSegFrames) {
    return { ...base, featureFrames: Math.max(0, nFrames), failure: 'too-short' };
  }

  // ---- 整段音频混合为单声道 ----
  const mono = new Float32Array(len);
  for (let c = 0; c < nCh; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i];
  }
  if (nCh > 1) {
    const inv = 1 / nCh;
    for (let i = 0; i < len; i++) mono[i] *= inv;
  }

  // ---- 对数频带划分（与接缝频谱检查口径一致）----
  const nyq = sr / 2;
  const fMin = Math.max(1, Math.min(options.minFreqHz ?? 40, nyq / 2));
  const binBand = new Int16Array(frame / 2 + 1).fill(-1);
  const logRatio = Math.log(nyq / fMin);
  for (let k = 1; k <= frame / 2; k++) {
    const f = (k * sr) / frame;
    if (f < fMin || f > nyq) continue;
    binBand[k] = Math.min(bands - 1, Math.floor((bands * Math.log(f / fMin)) / logRatio));
  }

  const hann = new Float32Array(frame);
  for (let i = 0; i < frame; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame - 1));
  }

  // ---- STFT：每帧的频带能量（dB，动态下限）与时域能量（静音掩码）----
  const feat = new Float32Array(nFrames * bands);
  const excluded = new Uint8Array(nFrames);
  const re = new Float32Array(frame);
  const im = new Float32Array(frame);
  const bandAcc = new Float64Array(bands);
  let maxE = 0;
  for (let f = 0; f < nFrames; f++) {
    const off = f * hop;
    let e = 0;
    for (let i = 0; i < frame; i++) {
      const x = mono[off + i];
      e += x * x;
      re[i] = x * hann[i];
      im[i] = 0;
    }
    e /= frame;
    if (e > maxE) maxE = e;
    fftInPlace(re, im);
    bandAcc.fill(0);
    for (let k = 1; k <= frame / 2; k++) {
      const b = binBand[k];
      if (b < 0) continue;
      bandAcc[b] += re[k] * re[k] + im[k] * im[k];
    }
    let total = 0;
    for (let b = 0; b < bands; b++) total += bandAcc[b];
    // 动态下限：帧总能量的 −90 dB（静音或异常时回落到绝对下限 EPS）
    const rel = total * 1e-9;
    const floor = rel > EPS ? rel : EPS;
    const row = f * bands;
    for (let b = 0; b < bands; b++) {
      const safe = bandAcc[b] > floor ? bandAcc[b] : floor;
      feat[row + b] = 10 * Math.log10(safe);
    }
    if (e < SILENCE_ENERGY) excluded[f] = 1;
  }
  if (maxE < SILENCE_ENERGY) return { ...base, featureFrames: nFrames, failure: 'silence' };

  // ---- 逐频带去均值（去除整体响度与频谱形状共性），帧向量 L2 归一化 ----
  for (let b = 0; b < bands; b++) {
    let m = 0;
    for (let f = 0; f < nFrames; f++) m += feat[f * bands + b];
    m /= nFrames;
    for (let f = 0; f < nFrames; f++) feat[f * bands + b] -= m;
  }
  const invNorm = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const row = f * bands;
    let s = 0;
    for (let b = 0; b < bands; b++) {
      const v = feat[row + b];
      s += v * v;
    }
    // 特征几乎为零（频谱恰好等于全曲平均）的帧无法匹配，强制排除
    invNorm[f] = s > 1e-18 ? 1 / Math.sqrt(s) : 0;
    if (invNorm[f] === 0) excluded[f] = 1;
  }

  // ---- 逐对角线匹配：sim(t, t+d) 的连续命中沿对角线合并 ----
  interface RawGroup {
    aStartFrame: number;
    segFrames: number;
    lagFrames: number;
    similarity: number;
  }
  const raw: RawGroup[] = [];
  const row = new Float32Array(nFrames);
  const dMax = nFrames - minSegFrames;
  for (let d = minSegFrames; d <= dMax; d++) {
    const limit = nFrames - d;
    for (let t = 0; t < limit; t++) {
      const o1 = t * bands;
      const o2 = (t + d) * bands;
      let s = 0;
      for (let b = 0; b < bands; b++) s += feat[o1 + b] * feat[o2 + b];
      row[t] = s * invNorm[t] * invNorm[t + d];
    }
    // 扫描命中段：连续 ≥ minSim 的命中合并为一次重复，允许 ≤ maxGap 帧断裂
    let runStart = -1;
    let lastHit = -1;
    let sum = 0;
    let cnt = 0;
    const flush = () => {
      if (runStart >= 0) {
        const L = lastHit - runStart + 1;
        if (L >= minSegFrames && cnt > 0) {
          raw.push({
            aStartFrame: runStart,
            // 段长夹取到滞后 d：A、B 首尾相接，互不重叠
            segFrames: Math.min(L, d),
            lagFrames: d,
            similarity: sum / cnt,
          });
        }
      }
      runStart = -1;
      sum = 0;
      cnt = 0;
    };
    for (let t = 0; t < limit; t++) {
      if (excluded[t] || excluded[t + d] || row[t] < minSim) continue;
      if (runStart >= 0 && t - lastHit > maxGap + 1) flush();
      if (runStart < 0) runStart = t;
      sum += row[t];
      cnt++;
      lastHit = t;
    }
    flush();
  }

  if (raw.length === 0) return { ...base, featureFrames: nFrames, failure: 'no-match' };

  // ---- 去重：按相似度降序贪心接受，两个区间起点均相近的视为同一重复 ----
  raw.sort((x, y) => y.similarity - x.similarity);
  const dedupSamples = Math.max(1, dedupSec * sr);
  const groups: RepeatMatch[] = [];
  for (const g of raw) {
    const aStart = g.aStartFrame * hop;
    const seg = g.segFrames * hop;
    const bStart = aStart + g.lagFrames * hop;
    let dup = false;
    for (const q of groups) {
      if (
        Math.abs(q.aStartSample - aStart) < dedupSamples &&
        Math.abs(q.bStartSample - bStart) < dedupSamples
      ) {
        dup = true;
        break;
      }
    }
    if (dup) continue;
    groups.push({
      aStartSample: aStart,
      aEndSample: aStart + seg,
      bStartSample: bStart,
      bEndSample: bStart + seg,
      similarity: Math.min(1, Math.max(0, g.similarity)),
    });
    if (groups.length >= maxGroups) break;
  }

  return { ...base, featureFrames: nFrames, groups };
}
