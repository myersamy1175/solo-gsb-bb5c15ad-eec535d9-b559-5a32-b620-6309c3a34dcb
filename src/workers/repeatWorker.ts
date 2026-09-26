import { detectRepeats } from '../audio/repeatDetect';
import type { RepeatDetectOptions, RepeatDetectResult } from '../audio/repeatDetect';

/**
 * 重复片段发现的后台 Worker：在独立线程中执行多频带能量特征提取与
 * 跨时间自相似匹配，避免阻塞页面。主线程通过 postMessage 传入
 * 声道数据副本（Transferable 转移，零拷贝），结果经结构化克隆返回。
 */

export interface RepeatAnalyzeRequest {
  sampleRate: number;
  channels: Float32Array[];
  options?: RepeatDetectOptions;
}

export type RepeatWorkerResponse =
  | { type: 'result'; result: RepeatDetectResult }
  | { type: 'error'; message: string };

// 与 DOM lib 并存的最小 Worker 全局对象类型（避免引入 webworker lib 的类型冲突）
interface WorkerScope {
  onmessage: ((e: MessageEvent<RepeatAnalyzeRequest>) => void) | null;
  postMessage(message: RepeatWorkerResponse, transfer?: Transferable[]): void;
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
    ctx.postMessage({ type: 'result', result: detectRepeats(audio, options) });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
