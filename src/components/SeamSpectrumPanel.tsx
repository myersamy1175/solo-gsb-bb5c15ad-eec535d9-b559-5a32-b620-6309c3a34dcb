import { useMemo } from 'react';
import type { SeamSpectrumResult } from '../audio/seamSpectrum';
import { SpectrumHeatmap, fmtFreq } from './SpectrumHeatmap';

interface SeamSpectrumPanelProps {
  /** 当前选中候选的分析结果（循环太短时可能为 null） */
  result: SeamSpectrumResult | null;
  /** 候选标签，如 "候选 #2" */
  candidateLabel: string;
  /** 检查窗长度（ms，50 ~ 500） */
  windowMs: number;
  onWindowMsChange: (v: number) => void;
}

export const MIN_WINDOW_MS = 50;
export const MAX_WINDOW_MS = 500;

/** 颜色量程取不小于 maxAbs 的「整齐」值，最小 ±3 dB */
function niceRange(maxAbs: number): number {
  const steps = [3, 6, 12, 24, 48, 96, 240];
  for (const s of steps) if (maxAbs <= s) return s;
  return 480;
}

/**
 * 接缝频谱检查面板：对比循环尾部与头部片段的 STFT 对数频带能量，
 * 以可缩放热图展示对应帧的差值，并汇总最大差值与最差频带。
 */
export function SeamSpectrumPanel({ result, candidateLabel, windowMs, onWindowMsChange }: SeamSpectrumPanelProps) {
  const rangeDb = useMemo(() => (result ? niceRange(result.maxAbsDiffDb) : 6), [result]);
  const effectiveMs = result ? (result.windowSamples / result.sampleRate) * 1000 : 0;

  return (
    <section className="panel spectrum">
      <h2>接缝频谱检查（{candidateLabel}）</h2>
      <p className="spectrum-desc">
        对循环尾部与头部各取一段检查窗，按重叠 Hann 窗做 STFT 并比较 8 个对数频带的能量差（头 − 尾，
        按与接缝的距离配对帧）。红色 = 头部能量偏高，蓝色 = 尾部偏高；静音 / 远弱频带按动态下限处理，不产生异常值。
      </p>

      <label className="spectrum-slider">
        <span>
          检查窗：<b>{windowMs} ms</b>
          {result?.clamped ? <em className="stale">（已夹取为 {effectiveMs.toFixed(0)} ms）</em> : null}
        </span>
        <input
          type="range"
          min={MIN_WINDOW_MS}
          max={MAX_WINDOW_MS}
          step={10}
          value={windowMs}
          onChange={(e) => onWindowMsChange(Number(e.target.value))}
        />
      </label>

      {result ? (
        <>
          {result.clamped && (
            <p className="clamp-note">
              检查窗超过循环长度的一半（{effectiveMs.toFixed(0)} ms），已自动夹取，避免首尾片段重叠。
            </p>
          )}
          <SpectrumHeatmap result={result} rangeDb={rangeDb} />
          <p className="spectrum-summary">
            最大差值 <b>{result.maxAbsDiffDb.toFixed(2)} dB</b>
            {' · '}最差频带 #{result.worstBand + 1}（
            {fmtFreq(result.bandEdgesHz[result.worstBand])}–
            {fmtFreq(result.bandEdgesHz[result.worstBand + 1])} Hz，峰值{' '}
            {result.bandMaxAbsDb[result.worstBand].toFixed(2)} dB）
            {' · '}帧数 {result.frameOffsetsSec.length} · FFT {result.fftSize} · 色标 ±{rangeDb} dB
          </p>
        </>
      ) : (
        <p className="clamp-note">循环区间太短，无法进行频谱分析。</p>
      )}
    </section>
  );
}
