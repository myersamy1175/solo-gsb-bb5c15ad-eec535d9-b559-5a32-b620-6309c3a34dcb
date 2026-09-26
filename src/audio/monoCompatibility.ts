import type { AudioDataLike } from './types';

/**
 * 立体声 → 单声道兼容性检查：
 * 按固定检查窗（默认 100 ms）与步长（默认 50 ms）逐窗计算
 *
 *   1. 左右声道相关度（去均值 Pearson 相关，[-1, 1]）：越接近 −1 抵消风险越高；
 *   2. 等权合并单声道 m = (L + R) / 2 相对原立体声的能量损失：
 *
 *        loss = 10·log10( E_mono / ((E_L + E_R) / 2) )   （dB，恒 ≤ 0）
 *
 *      L = R 时为 0 dB，R = −L（完全反相）时趋于 −∞。
 *
 * - 安静窗（双声道平均 RMS 电平低于 quietDbfs，默认 −50 dBFS）不参与风险判定；
 * - 损失达到风险阈值（lossDb ≤ −6 dB）的窗口标记为风险窗，
 *   时间上连续的风险窗沿时间轴合并为一个风险区间，
 *   区间汇报最差（最小）相关度与最大（最负）损失。
 */

export interface MonoCompatOptions {
  /** 检查窗长（秒），默认 0.1 */
  windowSec?: number;
  /** 步长（秒），默认 0.05 */
  hopSec?: number;
  /** 安静窗电平阈值（dBFS，双声道平均 RMS），默认 −50 */
  quietDbfs?: number;
  /** 风险区间的能量损失阈值（dB，损失达到该值即风险），默认 −6 */
  riskLossDb?: number;
}

export interface MonoCompatWindow {
  /** 窗起点 / 终点（采样点，终点不含） */
  startSample: number;
  endSample: number;
  /** 左右声道去均值 Pearson 相关度 [-1, 1]（某声道零方差时记为 1） */
  correlation: number;
  /** 等权单声道相对原立体声的能量损失（dB，≤ 0） */
  lossDb: number;
  /** 安静窗（不参与风险判定） */
  quiet: boolean;
  /** 风险窗（非安静且损失达到阈值） */
  risky: boolean;
}

export interface MonoCompatInterval {
  /** 区间起点 / 终点（采样点，终点不含；终点延伸至末窗结束位置） */
  startSample: number;
  endSample: number;
  /** 区间起点 / 终点（秒） */
  startSec: number;
  endSec: number;
  /** 合并的风险窗数量 */
  windowCount: number;
  /** 区间内最差（最小）左右声道相关度 */
  worstCorrelation: number;
  /** 区间内最大（最负）能量损失（dB） */
  maxLossDb: number;
}

export type MonoCompatFailure = 'not-stereo' | 'too-short';

export interface MonoCompatResult {
  /** 是否为可检查的双声道立体声（单声道 / 多声道文件为 false） */
  applicable: boolean;
  /** 不适用 / 过短时的原因；正常分析为 null */
  failure: MonoCompatFailure | null;
  /** 采样率 Hz */
  sampleRate: number;
  /** 检查窗 / 步长（采样点） */
  windowSamples: number;
  hopSamples: number;
  /** 实际使用的安静窗阈值（dBFS）与风险损失阈值（dB） */
  quietDbfs: number;
  riskLossDb: number;
  /** 逐窗结果（仅完整窗） */
  windows: MonoCompatWindow[];
  /** 合并后的风险区间（按时间顺序） */
  intervals: MonoCompatInterval[];
  /** 总窗数 / 安静窗数 / 风险窗数 */
  totalWindows: number;
  quietWindows: number;
  riskWindows: number;
}

/** 能量比下限：约 −120 dB，避免完全反相抵消时取对数得到 −Infinity */
const RATIO_FLOOR = 1e-12;

export function analyzeMonoCompatibility(
  audio: AudioDataLike,
  options: MonoCompatOptions = {},
): MonoCompatResult {
  const sr = audio.sampleRate;
  const windowSec = options.windowSec ?? 0.1;
  const hopSec = options.hopSec ?? 0.05;
  const quietDbfs = options.quietDbfs ?? -50;
  const riskLossDb = options.riskLossDb ?? -6;
  const win = Math.max(1, Math.round(windowSec * sr));
  const hop = Math.max(1, Math.round(hopSec * sr));

  const base: MonoCompatResult = {
    applicable: audio.numberOfChannels === 2,
    failure: null,
    sampleRate: sr,
    windowSamples: win,
    hopSamples: hop,
    quietDbfs,
    riskLossDb,
    windows: [],
    intervals: [],
    totalWindows: 0,
    quietWindows: 0,
    riskWindows: 0,
  };

  if (audio.numberOfChannels !== 2) return { ...base, failure: 'not-stereo' };
  const len = audio.length;
  if (len < win) return { ...base, failure: 'too-short' };

  const left = audio.getChannelData(0);
  const right = audio.getChannelData(1);
  // 双声道平均 RMS（线性），低于该电平的窗视为安静窗
  const quietRms = 10 ** (quietDbfs / 20);
  const quietEnergy = quietRms * quietRms;

  const windows: MonoCompatWindow[] = [];
  let quietWindows = 0;
  let riskWindows = 0;

  // 仅保留完整窗：末尾不足一个检查窗的部分忽略
  for (let start = 0; start + win <= len; start += hop) {
    let sL = 0;
    let sR = 0;
    let sLL = 0;
    let sRR = 0;
    let sLR = 0;
    for (let i = 0; i < win; i++) {
      const l = left[start + i];
      const r = right[start + i];
      sL += l;
      sR += r;
      sLL += l * l;
      sRR += r * r;
      sLR += l * r;
    }
    const n = win;
    const meanL = sL / n;
    const meanR = sR / n;
    const eL = sLL / n;
    const eR = sRR / n;
    const cov = sLR / n - meanL * meanR;
    const varL = Math.max(0, eL - meanL * meanL);
    const varR = Math.max(0, eR - meanR * meanR);
    const den = Math.sqrt(varL * varR);
    // 某声道为常量（零方差）时 Pearson 相关无定义：不存在反相抵消，记为 1
    const correlation = den > 0 ? Math.max(-1, Math.min(1, cov / den)) : 1;

    // 等权单声道能量 / 原立体声平均声道能量；由 Cauchy–Schwarz 恒有 ratio ≤ 1
    const eMono = (eL + eR + 2 * (sLR / n)) / 4;
    const eRef = (eL + eR) / 2;
    const ratio = eRef > 0 ? Math.max(RATIO_FLOOR, eMono / eRef) : RATIO_FLOOR;
    const lossDb = 10 * Math.log10(ratio);

    const quiet = (eL + eR) / 2 < quietEnergy;
    const risky = !quiet && lossDb <= riskLossDb;
    if (quiet) quietWindows++;
    if (risky) riskWindows++;
    windows.push({ startSample: start, endSample: start + win, correlation, lossDb, quiet, risky });
  }

  // 连续风险窗合并为区间（安静窗 / 非风险窗切断连续性）
  const intervals: MonoCompatInterval[] = [];
  let runStart = -1;
  for (let i = 0; i <= windows.length; i++) {
    const risky = i < windows.length && windows[i].risky;
    if (risky && runStart < 0) runStart = i;
    if (!risky && runStart >= 0) {
      const runEnd = i; // 排他
      let worstCorrelation = 1;
      let maxLossDb = 0;
      for (let j = runStart; j < runEnd; j++) {
        const w = windows[j];
        if (w.correlation < worstCorrelation) worstCorrelation = w.correlation;
        if (w.lossDb < maxLossDb) maxLossDb = w.lossDb;
      }
      const first = windows[runStart];
      const last = windows[runEnd - 1];
      intervals.push({
        startSample: first.startSample,
        endSample: last.endSample,
        startSec: first.startSample / sr,
        endSec: last.endSample / sr,
        windowCount: runEnd - runStart,
        worstCorrelation,
        maxLossDb,
      });
      runStart = -1;
    }
  }

  return {
    ...base,
    failure: null,
    windows,
    intervals,
    totalWindows: windows.length,
    quietWindows,
    riskWindows,
  };
}
