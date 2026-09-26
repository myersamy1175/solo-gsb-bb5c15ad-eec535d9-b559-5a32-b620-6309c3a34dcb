import type { MonoCompatResult } from '../audio/monoCompatibility';
import { fmtTime } from '../utils/format';

export type MonoCompatPlayTarget = 'compat-stereo' | 'compat-mono' | null;

interface MonoCompatPanelProps {
  /** 已加载文件的声道数（无文件时为 null） */
  channelCount: number | null;
  /** 后台分析结果（分析中 / 未开始时为 null） */
  result: MonoCompatResult | null;
  /** 后台分析进行中 */
  busy: boolean;
  /** 已载入选区的风险区间序号 */
  appliedIdx: number | null;
  /** 当前试听状态（原立体声 / 等权单声道 / 未试听） */
  playing: MonoCompatPlayTarget;
  onReanalyze: () => void;
  onSelectInterval: (idx: number) => void;
  onPlayStereo: () => void;
  onPlayMono: () => void;
  onStop: () => void;
}

/**
 * 立体声 / 单声道兼容性检查面板：列出等权合并单声道后能量损失达到 6 dB 的
 * 连续风险区间（时间、最差相关度、最大损失）；点击区间载入波形选区，
 * 可切换试听原立体声与等权单声道核对抵消。单声道（及多声道）文件显示不适用。
 */
export function MonoCompatPanel({
  channelCount,
  result,
  busy,
  appliedIdx,
  playing,
  onReanalyze,
  onSelectInterval,
  onPlayStereo,
  onPlayMono,
  onStop,
}: MonoCompatPanelProps) {
  const applicable = channelCount === 2;

  return (
    <section className="panel mono-compat">
      <h2>立体声 / 单声道兼容性检查</h2>
      <p className="mono-compat-desc">
        按 100 ms 检查窗、50 ms 步长逐窗计算左右声道相关度，以及等权合并为单声道
        m =（L + R）/ 2 相对原立体声的能量损失。低于 −50 dBFS 的安静窗不参与风险判定；
        连续损失达到 6 dB 的窗口合并为风险区间。点击区间可载入波形选区，
        并切换试听原立体声与等权单声道核对抵消。
      </p>

      {channelCount !== null && !applicable && (
        <p className="clamp-note">
          当前文件为 {channelCount === 1 ? '单声道' : `${channelCount} 声道`}音频：
          立体声 / 单声道兼容性检查不适用（仅对双声道立体声文件进行分析）。
        </p>
      )}

      {applicable && (
        <div className="transport">
          <button className="primary" onClick={onReanalyze} disabled={busy}>
            {busy ? '分析中…' : result ? '重新检查' : '兼容性检查'}
          </button>
          <button
            className={playing === 'compat-stereo' ? 'active' : ''}
            onClick={onPlayStereo}
            disabled={appliedIdx === null || busy}
          >
            {playing === 'compat-stereo' ? '■ 试听原立体声中' : '▶ 试听原立体声'}
          </button>
          <button
            className={playing === 'compat-mono' ? 'active' : ''}
            onClick={onPlayMono}
            disabled={appliedIdx === null || busy}
          >
            {playing === 'compat-mono' ? '■ 试听等权单声道中' : '▶ 试听等权单声道'}
          </button>
          <button onClick={onStop} disabled={playing === null}>停止</button>
        </div>
      )}

      {applicable && busy && !result && <p className="mono-compat-note">后台线程分析中，页面可继续操作…</p>}

      {applicable && result && !busy && result.failure === 'too-short' && (
        <p className="clamp-note">音频短于一个检查窗（100 ms），无法进行兼容性检查。</p>
      )}

      {applicable && result && result.failure === null && (
        <>
          <p className="mono-compat-summary">
            共 {result.totalWindows} 个检查窗（窗 {Math.round((result.windowSamples / result.sampleRate) * 1000)} ms /
            步长 {Math.round((result.hopSamples / result.sampleRate) * 1000)} ms），
            其中安静窗 {result.quietWindows} 个（低于 {result.quietDbfs} dBFS，不参与判定）、
            风险窗 {result.riskWindows} 个；合并得到 <b>{result.intervals.length}</b> 个风险区间。
          </p>
          {result.intervals.length === 0 ? (
            <p className="mono-compat-note">
              未发现风险区间：所有非安静窗等权合并单声道后的能量损失均小于 {Math.abs(result.riskLossDb)} dB，
              单声道兼容性良好。
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>区间</th>
                  <th>持续时间</th>
                  <th>窗数</th>
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
                    onClick={() => onSelectInterval(i)}
                  >
                    <td><span className="rank">{i + 1}</span></td>
                    <td>{fmtTime(iv.startSec)} – {fmtTime(iv.endSec)}</td>
                    <td>{fmtTime(iv.endSec - iv.startSec)}</td>
                    <td>{iv.windowCount}</td>
                    <td className={iv.worstCorrelation < 0 ? 'compat-bad' : ''}>
                      {iv.worstCorrelation.toFixed(2)}
                    </td>
                    <td className="compat-bad">{iv.maxLossDb.toFixed(2)} dB</td>
                    <td className="row-state">{i === appliedIdx ? '✓ 已载入选区' : '点击载入选区'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
