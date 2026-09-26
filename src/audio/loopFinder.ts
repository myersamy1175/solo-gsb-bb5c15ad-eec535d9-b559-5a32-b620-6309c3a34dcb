import type { AudioDataLike } from './types';

export interface SeamSearchOptions {
  /** 在每个边界两侧搜索的半径（采样点） */
  radiusSamples: number;
  /** 短窗斜率估计窗口长度（采样点），默认 32 */
  slopeWindow?: number;
  /** 斜率差相对幅值差的权重，默认 1 */
  slopeWeight?: number;
  /** 允许的最短循环长度（采样点），默认 64 */
  minLoopSamples?: number;
  /**
   * 定长约束（采样点）：设置后循环长度固定为该值，终点 = 起点 + fixedLoopSamples，
   * 起止点必须等量平移，搜索退化为对起点的一维搜索（搜索半径、候选去重不变）；
   * 缺省为自由二维搜索
   */
  fixedLoopSamples?: number;
}

export interface CandidateSearchOptions extends SeamSearchOptions {
  /** 返回的最大候选数量，默认 5 */
  maxCandidates?: number;
  /**
   * 去重阈值（采样点）：两个结果的起止点均相距不足该值时视为同一局部极小值，
   * 默认 10 ms（按音频采样率换算）
   */
  dedupSamples?: number;
}

export interface SeamResult {
  /** 优化后的循环起点（采样点，含） */
  startSample: number;
  /** 优化后的循环终点（采样点，不含） */
  endSample: number;
  /** 归一化代价值，越小接缝越平滑 */
  cost: number;
}

/**
 * 在用户粗选的两个边界附近搜索代价最低的若干接缝点对（候选对比模式）。
 *
 * 接缝代价 = Σ声道 ( |x[s] − x[e−1]| / RMS幅值
 *                  + w · |前向斜率(s) − 后向斜率(e)| / RMS斜率 )
 *
 * 其中前向斜率取 s 之后 W 个采样点的平均变化率，
 * 后向斜率取 e 之前 W 个采样点的平均变化率。
 *
 * 搜索采用「粗网格 + 局部细化」两级策略：先在粗网格上评估全部候选对
 * （总评估数控制在 ~30 万以内），按代价升序贪心挑选互不重复的粗候选——
 * 起止点均相距不足 dedupSamples 的命中视为同一局部极小值被跳过，
 * 避免列表被同一个低谷占满；再对每个粗候选在 ±stride 内逐采样点细化。
 * 细化后再次去重并按代价排序，返回前 maxCandidates 个结果
 * （按代价升序，第 0 个即最优接缝）。
 *
 * 定长模式（fixedLoopSamples）：循环长度固定，终点 = 起点 + fixedLoopSamples，
 * 起止点等量平移，搜索退化为对起点的一维搜索（粗网格与细化同策略），
 * 去重与排序逻辑不变；定长周期超出可搜索范围时返回空数组。
 */
export function findCandidateSeams(
  audio: AudioDataLike,
  roughStart: number,
  roughEnd: number,
  options: CandidateSearchOptions,
): SeamResult[] {
  const W = Math.max(4, Math.round(options.slopeWindow ?? 32));
  const slopeWeight = options.slopeWeight ?? 1;
  const minLoop = Math.max(2, Math.round(options.minLoopSamples ?? 64));
  const maxCandidates = Math.max(1, Math.round(options.maxCandidates ?? 5));
  const dedup = Math.max(1, Math.round(options.dedupSamples ?? audio.sampleRate * 0.01));
  const len = audio.length;
  const nCh = audio.numberOfChannels;
  const data: Float32Array[] = [];
  for (let c = 0; c < nCh; c++) data.push(audio.getChannelData(c));

  // ---- 归一化尺度：全信号幅值 RMS 与一阶差分 RMS（抽样估计）----
  let sumV = 0;
  let sumD = 0;
  let cnt = 0;
  const probeStep = Math.max(1, Math.floor(len / 65536));
  for (let i = probeStep; i < len; i += probeStep) {
    for (let c = 0; c < nCh; c++) {
      const x = data[c][i];
      sumV += x * x;
      const d = x - data[c][i - 1];
      sumD += d * d;
    }
    cnt += nCh;
  }
  const rmsV = Math.sqrt(sumV / Math.max(1, cnt)) || 1;
  const rmsD = Math.sqrt(sumD / Math.max(1, cnt)) || 1;

  // ---- 候选范围（保证斜率窗口不越界）----
  const r = Math.max(0, Math.round(options.radiusSamples));
  const lo = W + 1;
  const hi = len - W - 2;
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(v, b));
  const fixed =
    options.fixedLoopSamples != null && Number.isFinite(options.fixedLoopSamples)
      ? Math.max(minLoop, Math.round(options.fixedLoopSamples))
      : null;
  const sLo = clamp(Math.round(roughStart) - r, lo, hi);
  let sHi = clamp(Math.round(roughStart) + r, lo, hi);
  let eLo: number;
  let eHi: number;
  if (fixed !== null) {
    // 定长约束：终点由起点唯一确定（e = s + fixed），只需保证 e ≤ len − 1
    sHi = Math.min(sHi, len - 1 - fixed);
    eLo = sLo + fixed;
    eHi = sHi + fixed;
  } else {
    eLo = clamp(Math.round(roughEnd) - r, lo + 1, len - 1);
    eHi = clamp(Math.round(roughEnd) + r, lo + 1, len - 1);
  }

  const sCount = sHi - sLo + 1;
  const eCount = eHi - eLo + 1;
  if (sCount <= 0 || eCount <= 0) return [];

  // ---- 预计算候选点特征（归一化后的幅值与短窗斜率）----
  const sVal: Float32Array[] = [];
  const sSlope: Float32Array[] = [];
  const eVal: Float32Array[] = [];
  const eSlope: Float32Array[] = [];
  for (let c = 0; c < nCh; c++) {
    const x = data[c];
    const sv = new Float32Array(sCount);
    const ss = new Float32Array(sCount);
    for (let i = 0; i < sCount; i++) {
      const idx = sLo + i;
      sv[i] = x[idx] / rmsV;
      ss[i] = (x[idx + W] - x[idx]) / W / rmsD;
    }
    const ev = new Float32Array(eCount);
    const es = new Float32Array(eCount);
    for (let j = 0; j < eCount; j++) {
      const idx = eLo + j;
      ev[j] = x[idx - 1] / rmsV;
      es[j] = (x[idx - 1] - x[idx - 1 - W]) / W / rmsD;
    }
    sVal.push(sv);
    sSlope.push(ss);
    eVal.push(ev);
    eSlope.push(es);
  }

  const pairCost = (si: number, ei: number): number => {
    let c = 0;
    for (let ch = 0; ch < nCh; ch++) {
      c += Math.abs(sVal[ch][si] - eVal[ch][ei]);
      c += slopeWeight * Math.abs(sSlope[ch][si] - eSlope[ch][ei]);
    }
    return c;
  };

  // ---- 第一级：粗网格搜索，收集全部命中 ----
  const totalPairs = fixed !== null ? sCount : sCount * eCount;
  const stride = Math.max(1, Math.round(Math.sqrt(totalPairs / 300_000)));
  const hitCost: number[] = [];
  const hitS: number[] = [];
  const hitE: number[] = [];
  for (let i = 0; i < sCount; i += stride) {
    const s = sLo + i;
    if (fixed !== null) {
      // 定长约束：终点 = 起点 + fixed（特征索引与起点相同）
      hitCost.push(pairCost(i, i));
      hitS.push(s);
      hitE.push(s + fixed);
      continue;
    }
    for (let j = 0; j < eCount; j += stride) {
      const e = eLo + j;
      if (e - s < minLoop) continue;
      hitCost.push(pairCost(i, j));
      hitS.push(s);
      hitE.push(e);
    }
  }
  if (hitCost.length === 0) return [];

  // ---- 计数排序：按代价升序排列命中索引。
  // 代价量化为 65536 个桶，同桶内顺序不重要——最终候选在细化后会按精确代价重排；
  // 相比对 ~30 万元素做比较器排序（数百毫秒），计数排序只需几毫秒 ----
  const hitCount = hitCost.length;
  let minC = Infinity;
  let maxC = -Infinity;
  for (let k = 0; k < hitCount; k++) {
    const c = hitCost[k];
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
  }
  const BUCKETS = 65536;
  const bucketScale = (BUCKETS - 1) / (maxC - minC || 1);
  const bucketOf = (k: number): number => ((hitCost[k] - minC) * bucketScale) | 0;
  const offsets = new Uint32Array(BUCKETS);
  for (let k = 0; k < hitCount; k++) offsets[bucketOf(k)]++;
  let acc = 0;
  for (let b = 0; b < BUCKETS; b++) {
    const n = offsets[b];
    offsets[b] = acc;
    acc += n;
  }
  const order = new Uint32Array(hitCount);
  for (let k = 0; k < hitCount; k++) order[offsets[bucketOf(k)]++] = k;

  // ---- 贪心挑选互不重复的粗候选（多取一些，为细化后的合并留出余量）----
  const poolSize = Math.max(maxCandidates * 3, 6);
  const pool: SeamResult[] = [];
  for (let o = 0; o < hitCount; o++) {
    const k = order[o];
    const s = hitS[k];
    const e = hitE[k];
    let dup = false;
    for (const p of pool) {
      if (Math.abs(p.startSample - s) < dedup && Math.abs(p.endSample - e) < dedup) {
        dup = true;
        break;
      }
    }
    if (dup) continue;
    pool.push({ startSample: s, endSample: e, cost: hitCost[k] });
    if (pool.length >= poolSize) break;
  }

  // ---- 第二级：每个粗候选在 ±stride 内逐采样点细化 ----
  if (stride > 1) {
    for (const p of pool) {
      const iFrom = Math.max(sLo, p.startSample - stride);
      const iTo = Math.min(sHi, p.startSample + stride);
      if (fixed !== null) {
        // 定长约束：仅沿起点一维细化，终点同步平移
        for (let s = iFrom; s <= iTo; s++) {
          const c = pairCost(s - sLo, s - sLo);
          if (c < p.cost) {
            p.cost = c;
            p.startSample = s;
            p.endSample = s + fixed;
          }
        }
        continue;
      }
      const jFrom = Math.max(eLo, p.endSample - stride);
      const jTo = Math.min(eHi, p.endSample + stride);
      for (let s = iFrom; s <= iTo; s++) {
        for (let e = jFrom; e <= jTo; e++) {
          if (e - s < minLoop) continue;
          const c = pairCost(s - sLo, e - eLo);
          if (c < p.cost) {
            p.cost = c;
            p.startSample = s;
            p.endSample = e;
          }
        }
      }
    }
  }

  // ---- 细化后再次去重（不同粗候选可能收敛到同一极小值），按代价排序取前 N ----
  pool.sort((a, b) => a.cost - b.cost);
  const result: SeamResult[] = [];
  for (const p of pool) {
    let dup = false;
    for (const q of result) {
      if (
        Math.abs(q.startSample - p.startSample) < dedup &&
        Math.abs(q.endSample - p.endSample) < dedup
      ) {
        dup = true;
        break;
      }
    }
    if (dup) continue;
    result.push({ startSample: p.startSample, endSample: p.endSample, cost: p.cost });
    if (result.length >= maxCandidates) break;
  }
  return result;
}

/**
 * 只取最优接缝的便捷封装（等价于 findCandidateSeams 的第 0 个结果）。
 * 搜索空间无效时兜底返回粗选边界（cost 为 NaN）。
 */
export function findBestSeam(
  audio: AudioDataLike,
  roughStart: number,
  roughEnd: number,
  options: SeamSearchOptions,
): SeamResult {
  const [best] = findCandidateSeams(audio, roughStart, roughEnd, { ...options, maxCandidates: 1 });
  if (best) return best;
  const len = audio.length;
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(v, b));
  return {
    startSample: clamp(Math.round(roughStart), 0, len - 2),
    endSample: clamp(Math.round(roughEnd), 1, len),
    cost: NaN,
  };
}
