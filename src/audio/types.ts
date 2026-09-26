/**
 * 结构化音频数据接口：AudioBuffer 天然满足该接口，
 * 同时便于在 Node 环境下用普通对象做单元测试。
 */
export interface AudioDataLike {
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

/** 与 Web Audio 解耦的 PCM 数据，便于测试与包装为 AudioBuffer。 */
export interface PcmBuffer {
  sampleRate: number;
  channels: Float32Array[];
}
