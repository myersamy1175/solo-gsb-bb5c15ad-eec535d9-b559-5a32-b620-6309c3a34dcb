import type { AudioDataLike, PcmBuffer } from './types';

/**
 * 立体声 / 单声道兼容性检查：导入双声道音频后，按固定检查窗（100 ms）与
 * 步长（50 ms）滑过整段音频，逐窗评估
 *
 * - 左右声道相关度：窗内 L / R 的归一化自相关（Pearson 相关系数，−1 ~ 1，
 *   越接近 −1 反相越严重）；
 * - 等权合并能量损失：mono = (L + R) / 2 的均方能量相对原立体声
 *   两声道均方和的衰减量（dB，≥ 3.01 dB；反相抵消时趋近 ∞）。
 *
 * 每声道 RMS 低于 −50 dBFS 的安静窗不参与风险判定；连续损失达到 6 dB 的
 * 相邻风险窗合并为风险区间，报告区间时间、最差相关度与最大损失。
 * 单声道文件（numberOfChannels < 2）返回 null，由调用方显示「不适用」。
 */

export interface MonoCompatOptions {
  /** 检查窗长（秒），默认 0.1（100 ms） */
  windowSec?: number;
  /** 步长（秒），默认 0.05（50 ms） */
  hopSec?: number;
  /** 安静窗阈值（每声道 dBFS），默认 −50；低于该值的窗不参与判定 */
  silenceDbfs?: number;
  /** 风险阈值（等权合并损失 dB），默认 6 */
  lossThresholdDb?: number;
}

export interface MonoCompatWindow {
  /** 窗序号（按时间递增，相邻序号即连续窗） */
  index: number;
  /** 窗起点 / 终点（秒，终点不含） */
  startSec: number;
  endSec: number;
  /** 窗起点 / 终点（采样点，终点不含） */
  startSample: number;
  endSample: number;
  /** 左右声道归一化相关系数 [−1, 1] */
  correlation: number;
  /** 等权合并单声道相对原立体声的能量损失（dB ≥ 3.01；完全抵消为 Infinity） */
  lossDb: number;
  /** 安静窗（每声道 RMS 低于阈值），不参与风险判定 */
  quiet: boolean;
  /** 风险窗：非安静且损失达到阈值 */
  risk: boolean;
}

export interface MonoCompatRiskInterval {
  /** 区间起点 / 终点（秒，终点为最后一个风险窗的终点） */
  startSec: number;
  endSec: number;
  /** 区间起点 / 终点（采样点） */
  startSample: number;
  endSample: number;
  /** 合并的风险窗数量 */
  windowCount: number;
  /** 区间内最差（最小）左右声道相关度 */
  worstCorrelation: number;
  /** 区间内最大等权合并损失（dB，完全抵消为 Infinity） */
  maxLossDb: number;
}

export interface MonoCompatResult {
  sampleRate: number;
  /** 源文件声道数（多声道取前两声道作为 L / R） */
  channels: number;
  /** 实际检查窗 / 步长（采样点） */
  windowSamples: number;
  hopSamples: number;
  /** 安静窗阈值（dBFS） */
  silenceDbfs: number;
  /** 风险阈值（损失 dB） */
  lossThresholdDb: number;
  /** 全部检查窗（含安静窗与非风险窗） */
  windows: MonoCompatWindow[];
  /** 连续风险窗合并得到的风险区间 */
  intervals: MonoCompatRiskInterval[];
  /** 安静窗数量（不参与判定） */
  quietCount: number;
  /** 风险窗数量 */
  riskCount: number;
}

/**
 * 执行立体声 / 单声道兼容性检查。
 *
 * @param audio 已解码音频；至少需要两个声道
 * @returns 检查结果；单声道或参数非法时返回 null（调用方显示「不适用」）
 */
export function analyzeMonoCompat(
  audio: AudioDataLike,
  options: MonoCompatOptions = {},
): MonoCompatResult | null {
  const sr = audio.sampleRate;
  const len = audio.length;
  const nCh = audio.numberOfChannels;
  if (nCh < 2 || !Number.isFinite(sr) || sr <= 0 || len <= 0) return null;

  const win = Math.max(16, Math.round((options.windowSec ?? 0.1) * sr));
  const hop = Math.max(1, Math.round((options.hopSec ?? 0.05) * sr));
  const silenceDbfs = options.silenceDbfs ?? -50;
  const lossThresholdDb = options.lossThresholdDb ?? 6;
  // 每声道均方能量阈值：RMS 低于该值（dBFS）视为安静窗
  const silenceEnergy = 10 ** (silenceDbfs / 10);

  // 多声道文件取前两声道作为 L / R（与试听等权合并口径一致）
  const L = audio.getChannelData(0);
  const R = audio.getChannelData(1);

  const windows: MonoCompatWindow[] = [];
  let quietCount = 0;
  let riskCount = 0;
  const nWindows = len >= win ? Math.floor((len - win) / hop) + 1 : 0;

  for (let w = 0; w < nWindows; w++) {
    const startSample = w * hop;
    const endSample = startSample + win;

    // 一阶 / 二阶累加和（float64 累加，避免长窗精度问题）
    let sumL = 0;
    let sumR = 0;
    let sumLL = 0;
    let sumRR = 0;
    let sumLR = 0;
    for (let i = startSample; i < endSample; i++) {
      const l = L[i];
      const r = R[i];
      sumL += l;
      sumR += r;
      sumLL += l * l;
      sumRR += r * r;
      sumLR += l * r;
    }
    const n = win;

    // ---- Pearson 相关系数：去均值后的归一化互相关 ----
    let varL = sumLL - (sumL * sumL) / n;
    let varR = sumRR - (sumR * sumR) / n;
    if (varL < 0) varL = 0; // 常量信号下抵消可能得到微小负值
    if (varR < 0) varR = 0;
    const cov = sumLR - (sumL * sumR) / n;
    const denom = Math.sqrt(varL * varR);
    let correlation: number;
    if (denom > 0) {
      correlation = cov / denom;
    } else if (varL === 0 && varR === 0) {
      // 两侧均为常量（数字静音 / 直流）：同号视为完全正相关，异号完全反相
      correlation = sumL * sumR >= 0 ? 1 : -1;
    } else {
      // 仅一侧为常量：相关度不可定义，按不相关处理
      correlation = 0;
    }
    if (correlation > 1) correlation = 1;
    else if (correlation < -1) correlation = -1;

    // ---- 能量：立体声均方和 vs 等权合并单声道均方 ----
    const stereoE = (sumLL + sumRR) / n;
    const monoE = (sumLL + 2 * sumLR + sumRR) / (4 * n);
    const quiet = stereoE / 2 < silenceEnergy;
    const lossDb = monoE > 0 ? 10 * Math.log10(stereoE / monoE) : Infinity;
    const risk = !quiet && lossDb >= lossThresholdDb;
    if (quiet) quietCount++;
    if (risk) riskCount++;

    windows.push({
      index: w,
      startSec: startSample / sr,
      endSec: endSample / sr,
      startSample,
      endSample,
      correlation,
      lossDb,
      quiet,
      risk,
    });
  }

  // ---- 连续风险窗（相邻序号）合并为风险区间 ----
  const intervals: MonoCompatRiskInterval[] = [];
  let runStart = -1;
  const flush = (endExclusive: number) => {
    if (runStart < 0) return;
    const first = windows[runStart];
    const last = windows[endExclusive - 1];
    let worstCorrelation = first.correlation;
    let maxLossDb = first.lossDb;
    for (let w = runStart + 1; w < endExclusive; w++) {
      const winStat = windows[w];
      if (winStat.correlation < worstCorrelation) worstCorrelation = winStat.correlation;
      if (winStat.lossDb > maxLossDb) maxLossDb = winStat.lossDb;
    }
    intervals.push({
      startSec: first.startSec,
      endSec: last.endSec,
      startSample: first.startSample,
      endSample: last.endSample,
      windowCount: endExclusive - runStart,
      worstCorrelation,
      maxLossDb,
    });
    runStart = -1;
  };
  for (let w = 0; w < windows.length; w++) {
    if (windows[w].risk) {
      if (runStart < 0) runStart = w;
    } else {
      flush(w);
    }
  }
  flush(windows.length);

  return {
    sampleRate: sr,
    channels: nCh,
    windowSamples: win,
    hopSamples: hop,
    silenceDbfs,
    lossThresholdDb,
    windows,
    intervals,
    quietCount,
    riskCount,
  };
}

/**
 * 提取 [startSample, endSample) 区间用于兼容性核对试听：
 *
 * - mono = false：保留全部声道（原立体声，多声道原样保留）；
 * - mono = true：输出与分析口径一致的等权合并单声道 (L + R) / 2（取前两声道）。
 */
export function buildCompatAuditionPcm(
  source: AudioDataLike,
  startSample: number,
  endSample: number,
  mono: boolean,
): PcmBuffer {
  const len = source.length;
  const s = Math.max(0, Math.min(Math.round(startSample), len - 1));
  const e = Math.max(s + 1, Math.min(Math.round(endSample), len));
  const n = e - s;

  if (!mono) {
    const channels: Float32Array[] = [];
    for (let c = 0; c < source.numberOfChannels; c++) {
      channels.push(source.getChannelData(c).slice(s, e));
    }
    return { sampleRate: source.sampleRate, channels };
  }

  const L = source.getChannelData(0);
  const R = source.getChannelData(1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (L[s + i] + R[s + i]) * 0.5;
  }
  return { sampleRate: source.sampleRate, channels: [out] };
}
