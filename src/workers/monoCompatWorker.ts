import { analyzeMonoCompatibility } from '../audio/monoCompatibility';
import type { MonoCompatOptions, MonoCompatResult } from '../audio/monoCompatibility';

/**
 * 立体声 → 单声道兼容性检查的后台 Worker：在独立线程逐窗计算
 * 左右声道相关度与等权单声道能量损失，避免长音频分析时阻塞页面。
 * 主线程通过 postMessage 传入声道数据副本（Transferable 转移，零拷贝），
 * 结果经结构化克隆返回。
 */

export interface MonoCompatRequest {
  sampleRate: number;
  channels: Float32Array[];
  options?: MonoCompatOptions;
}

export type MonoCompatWorkerResponse =
  | { type: 'result'; result: MonoCompatResult }
  | { type: 'error'; message: string };

// 与 DOM lib 并存的最小 Worker 全局对象类型（避免引入 webworker lib 的类型冲突）
interface WorkerScope {
  onmessage: ((e: MessageEvent<MonoCompatRequest>) => void) | null;
  postMessage(message: MonoCompatWorkerResponse, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

ctx.onmessage = (e) => {
  const { sampleRate, channels, options } = e.data;
  try {
    const audio = {
      numberOfChannels: channels.length,
      sampleRate,
      length: channels[0]?.length ?? 0,
      getChannelData: (c: number) => channels[c],
    };
    ctx.postMessage({ type: 'result', result: analyzeMonoCompatibility(audio, options) });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
