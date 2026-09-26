import type { MonoCompatResult, MonoCompatRiskInterval } from '../audio/monoCompat';
import { fmtLossDb, fmtTime } from '../utils/format';

/** 风险区间试听模式：原立体声 / 等权单声道 */
export type RiskPlayMode = 'risk-stereo' | 'risk-mono';

interface MonoCompatPanelProps {
  /** 兼容性检查结果；单声道文件为 null（显示不适用提示） */
  result: MonoCompatResult | null;
  /** 源文件声道数 */
  channels: number;
  /** 已载入波形选区的风险区间序号；未载入时为 null */
  appliedIdx: number | null;
  /** 当前风险区间试听模式（其他试听 / 停止时为 null） */
  playing: RiskPlayMode | null;
  onApplyInterval: (interval: MonoCompatRiskInterval, idx: number) => void;
  onPlay: (mode: RiskPlayMode) => void;
  onStop: () => void;
}

/**
 * 立体声 / 单声道兼容性检查面板：列出连续合并能量损失达标的风险区间
 * （区间时间、最差相关度、最大损失），点击区间载入波形选区，
 * 并可循环切换试听原立体声与等权单声道以核对抵消。
 */
export function MonoCompatPanel({
  result,
  channels,
  appliedIdx,
  playing,
  onApplyInterval,
  onPlay,
  onStop,
}: MonoCompatPanelProps) {
  const windowMs = result ? (result.windowSamples / result.sampleRate) * 1000 : 0;
  const hopMs = result ? (result.hopSamples / result.sampleRate) * 1000 : 0;
  const applied = appliedIdx !== null && result ? result.intervals[appliedIdx] ?? null : null;

  return (
    <section className="panel compat">
      <h2>立体声 / 单声道兼容性检查</h2>
      <p className="compat-desc">
        导入双声道文件后自动执行：按 100 ms 检查窗、50 ms 步长逐窗计算左右声道相关度，
        以及等权合并为单声道相对原立体声的能量损失；低于 −50 dBFS 的安静窗不参与风险判定，
        连续损失达到 6 dB 的窗口合并为风险区间。点击任意区间将其载入波形选区，
        再切换试听原立体声与等权单声道，核对合并后的抵消与音量塌陷。
      </p>

      {channels < 2 ? (
        <p className="clamp-note">
          不适用：当前文件为单声道（{channels} 声道），不存在立体声合并抵消问题。
        </p>
      ) : result && result.windows.length === 0 ? (
        <p className="clamp-note">
          音频短于一个检查窗（{windowMs.toFixed(0)} ms），无法进行兼容性检查。
        </p>
      ) : result ? (
        <>
          <p className="compat-summary">
            检查窗 <b>{windowMs.toFixed(0)} ms</b> · 步长 <b>{hopMs.toFixed(0)} ms</b> ·
            共 <b>{result.windows.length}</b> 窗（安静窗 {result.quietCount} 个不参与判定）·
            风险窗 {result.riskCount} 个 → 合并为 <b>{result.intervals.length}</b> 个风险区间
          </p>

          {result.intervals.length === 0 ? (
            <p className="ok-note">
              ✓ 未发现达到 {result.lossThresholdDb} dB 合并损失的风险区间，等权合并为单声道兼容性良好。
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>风险区间</th>
                  <th>时长</th>
                  <th>最差相关度</th>
                  <th>最大损失</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {result.intervals.map((iv, i) => (
                  <tr
                    key={i}
                    className={i === appliedIdx ? 'selected' : ''}
                    onClick={() => onApplyInterval(iv, i)}
                  >
                    <td><span className="rank">{i + 1}</span></td>
                    <td>{fmtTime(iv.startSec)} – {fmtTime(iv.endSec)}</td>
                    <td>{fmtTime(iv.endSec - iv.startSec)}</td>
                    <td className={iv.worstCorrelation < 0 ? 'neg' : ''}>
                      {iv.worstCorrelation.toFixed(2)}
                    </td>
                    <td>{fmtLossDb(iv.maxLossDb)}</td>
                    <td className="row-state">
                      {i === appliedIdx ? '✓ 已载入选区' : '点击载入选区'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {applied && (
            <>
              <div className="transport">
                <button
                  className={playing === 'risk-stereo' ? 'active' : ''}
                  onClick={() => (playing === 'risk-stereo' ? onStop() : onPlay('risk-stereo'))}
                >
                  {playing === 'risk-stereo' ? '■ 停止' : '▶ 试听原立体声'}
                </button>
                <button
                  className={playing === 'risk-mono' ? 'active' : ''}
                  onClick={() => (playing === 'risk-mono' ? onStop() : onPlay('risk-mono'))}
                >
                  {playing === 'risk-mono' ? '■ 停止' : '▶ 试听等权单声道'}
                </button>
              </div>
              <p className="compat-hint">
                循环试听风险区间 #{(appliedIdx ?? 0) + 1}（{fmtTime(applied.startSec)} –{' '}
                {fmtTime(applied.endSec)}）：A/B 对比原立体声与等权单声道，单声道明显变弱或内容消失即存在合并抵消。
              </p>
            </>
          )}
        </>
      ) : null}
    </section>
  );
}
