import type { PcmBuffer } from './types';

/**
 * 循环试听播放器：复用同一个 AudioContext，
 * 启停时做 20ms 淡入淡出避免操作本身产生爆音。
 */
export class LoopPlayer {
  private ctx: AudioContext | null = null;
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;

  getContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  get playing(): boolean {
    return this.src !== null;
  }

  async play(pcm: PcmBuffer): Promise<void> {
    const ctx = this.getContext();
    if (ctx.state === 'suspended') await ctx.resume();
    this.stop();

    const buf = ctx.createBuffer(pcm.channels.length, pcm.channels[0].length, pcm.sampleRate);
    for (let i = 0; i < pcm.channels.length; i++) {
      buf.copyToChannel(pcm.channels[i], i);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + 0.02);
    src.connect(g);
    g.connect(ctx.destination);
    src.start();
    this.src = src;
    this.gain = g;
  }

  stop(): void {
    if (!this.ctx || !this.src || !this.gain) {
      this.src = null;
      this.gain = null;
      return;
    }
    const src = this.src;
    const g = this.gain;
    const t = this.ctx.currentTime;
    try {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0, t + 0.02);
      src.stop(t + 0.03);
    } catch {
      // 已停止，忽略
    }
    src.onended = () => {
      src.disconnect();
      g.disconnect();
    };
    this.src = null;
    this.gain = null;
  }
}
