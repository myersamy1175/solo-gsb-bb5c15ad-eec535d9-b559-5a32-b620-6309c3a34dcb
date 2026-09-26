import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Waveform, type Region, type SeamMarker } from './components/Waveform';
import { SeamSpectrumPanel } from './components/SeamSpectrumPanel';
import { MonoCompatPanel, type MonoCompatPlayTarget } from './components/MonoCompatPanel';
import { LoopPlayer } from './audio/player';
import { decodeAudioFile } from './audio/decode';
import { findCandidateSeams, type SeamResult } from './audio/loopFinder';
import { detectPeriods, type PeriodCandidate, type PeriodDetectFailure } from './audio/periodDetect';
import { buildLoopPcm } from './audio/loopBuffer';
import { analyzeSeamSpectrum } from './audio/seamSpectrum';
import { encodeWav, wavFileSize } from './audio/wavExport';
import type { MonoCompatInterval, MonoCompatResult } from './audio/monoCompatibility';
import type { MonoCompatWorkerResponse } from './workers/monoCompatWorker';
import type { RepeatDetectResult, RepeatMatch } from './audio/repeatDetect';
import type { RepeatWorkerResponse } from './workers/repeatWorker';
import { fmtBytes, fmtTime } from './utils/format';

const SLOPE_WINDOW = 32;
const SLOPE_WEIGHT = 1;
const MIN_LOOP_SECONDS = 0.05;
/** 候选接缝数量（按代价升序） */
const MAX_CANDIDATES = 5;
/** 周期候选数量（按置信度降序） */
const MAX_PERIOD_CANDIDATES = 3;
/** 重复片段发现：命中的最小余弦相似度（与 JSON 导出口径一致） */
const REPEAT_MIN_SIMILARITY = 0.9;
/** 重复片段发现：最短段落时长（秒） */
const REPEAT_MIN_SEGMENT_SEC = 0.5;
/** 重复片段发现：最多列出的组数 */
const MAX_REPEAT_GROUPS = 5;
/** 立体声/单声道兼容性检查：检查窗（ms）、步长（ms）、安静窗阈值（dBFS）、风险损失阈值（dB） */
const MONO_COMPAT_WINDOW_MS = 100;
const MONO_COMPAT_HOP_MS = 50;
const MONO_COMPAT_QUIET_DBFS = -50;
const MONO_COMPAT_RISK_LOSS_DB = -6;

/** 保留 decimals 位小数的有限数值（防御 NaN / Infinity 进入 JSON） */
const roundTo = (x: number, decimals: number): number => {
  if (!Number.isFinite(x)) return 0;
  const p = 10 ** decimals;
  return Math.round(x * p) / p;
};

type PlayTarget = 'original' | 'optimized' | 'compat-stereo' | 'compat-mono';

export default function App() {
  const [fileName, setFileName] = useState('');
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [selection, setSelection] = useState<Region | null>(null);
  const [candidates, setCandidates] = useState<SeamResult[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [radiusMs, setRadiusMs] = useState(50);
  const [crossfadeMs, setCrossfadeMs] = useState(20);
  const [specWindowMs, setSpecWindowMs] = useState(200);
  const [playing, setPlaying] = useState<PlayTarget | null>(null);
  const [status, setStatus] = useState('请导入 WAV / MP3 音频文件（音频仅在本地浏览器处理，不会上传）。');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // 周期校准：候选列表、无候选原因、已吸附的候选（定长约束生效中）、吸附前的选区
  const [periodCandidates, setPeriodCandidates] = useState<PeriodCandidate[]>([]);
  const [periodFailure, setPeriodFailure] = useState<PeriodDetectFailure | null>(null);
  const [appliedPeriod, setAppliedPeriod] = useState<PeriodCandidate | null>(null);
  const [preSnapSelection, setPreSnapSelection] = useState<Region | null>(null);
  // 重复片段发现：后台 Worker 分析结果、分析中标记、已载入选区的组序号
  const [repeatResult, setRepeatResult] = useState<RepeatDetectResult | null>(null);
  const [repeatBusy, setRepeatBusy] = useState(false);
  const [appliedRepeatIdx, setAppliedRepeatIdx] = useState<number | null>(null);
  // 立体声/单声道兼容性检查：后台 Worker 结果、分析中标记、已载入选区的风险区间序号
  const [compatResult, setCompatResult] = useState<MonoCompatResult | null>(null);
  const [compatBusy, setCompatBusy] = useState(false);
  const [appliedCompatIdx, setAppliedCompatIdx] = useState<number | null>(null);
  const playerRef = useRef<LoopPlayer | null>(null);
  const repeatWorkerRef = useRef<Worker | null>(null);
  // 分析请求令牌：换文件 / 重新分析时使过期的 Worker 回包失效
  const repeatTokenRef = useRef(0);
  const compatWorkerRef = useRef<Worker | null>(null);
  const compatTokenRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 当前选中的候选接缝：「试听选中候选」与 JSON / WAV 导出的目标
  const seam = candidates[selectedIdx] ?? null;

  // 定长约束的循环长度（采样点）；未吸附周期时为 null（自由搜索）
  const fixedLoopSamples = appliedPeriod ? Math.round(appliedPeriod.periodSamples) : null;

  // 接缝频谱检查：当前候选的循环 PCM（与试听 / 导出口径一致，含交叉淡化），
  // 切换候选或调整交叉淡化时自动重建，频谱分析随之实时重算
  const loopPcm = useMemo(() => {
    if (!buffer || !seam) return null;
    return buildLoopPcm(buffer, seam.startSample, seam.endSample, (crossfadeMs / 1000) * buffer.sampleRate);
  }, [buffer, seam, crossfadeMs]);

  const spectrum = useMemo(() => {
    if (!loopPcm) return null;
    return analyzeSeamSpectrum(loopPcm, (specWindowMs / 1000) * loopPcm.sampleRate);
  }, [loopPcm, specWindowMs]);

  const getPlayer = (): LoopPlayer => {
    if (!playerRef.current) playerRef.current = new LoopPlayer();
    return playerRef.current;
  };

  // 卸载时停止播放并终止后台分析线程
  useEffect(() => {
    return () => {
      playerRef.current?.stop();
      repeatWorkerRef.current?.terminate();
      repeatWorkerRef.current = null;
      compatWorkerRef.current?.terminate();
      compatWorkerRef.current = null;
    };
  }, []);

  /**
   * 立体声/单声道兼容性检查：在后台 Worker 逐窗计算左右声道相关度与等权单声道能量损失。
   * buf 缺省为当前已加载缓冲（换文件后自动分析时显式传入新缓冲，避免闭包读到旧值）。
   */
  const runMonoCompat = useCallback((buf?: AudioBuffer, baseStatus?: string) => {
    const target = buf ?? buffer;
    if (!target) return;
    if (target.numberOfChannels !== 2) return;
    if (!compatWorkerRef.current) {
      compatWorkerRef.current = new Worker(
        new URL('./workers/monoCompatWorker.ts', import.meta.url),
        { type: 'module' },
      );
    }
    const worker = compatWorkerRef.current;
    const token = ++compatTokenRef.current;
    const sr = target.sampleRate;
    // 复制声道数据并转移所有权（不能转移 AudioBuffer 内部数组，否则波形 / 试听失效）
    const channels: Float32Array[] = [];
    for (let c = 0; c < target.numberOfChannels; c++) {
      channels.push(target.getChannelData(c).slice());
    }
    setCompatBusy(true);
    setStatus(
      (baseStatus ? `${baseStatus} ` : '') +
        '立体声/单声道兼容性检查：后台线程按 100 ms 窗、50 ms 步长计算声道相关度与等权单声道能量损失…',
    );
    worker.onmessage = (e: MessageEvent<MonoCompatWorkerResponse>) => {
      if (token !== compatTokenRef.current) return; // 已换文件或重新分析，丢弃过期结果
      setCompatBusy(false);
      const msg = e.data;
      if (msg.type === 'error') {
        setStatus(`立体声/单声道兼容性检查失败：${msg.message}。可点击「重新检查」重试。`);
        return;
      }
      const res = msg.result;
      setCompatResult(res);
      setAppliedCompatIdx(null);
      if (res.failure === 'too-short') {
        setStatus('立体声/单声道兼容性检查：音频短于一个检查窗（100 ms），无法分析。');
        return;
      }
      const n = res.intervals.length;
      if (n === 0) {
        setStatus(
          `立体声/单声道兼容性检查完成：${res.totalWindows} 个检查窗（安静窗 ${res.quietWindows} 个不参与判定），` +
            `未发现连续损失达到 ${Math.abs(MONO_COMPAT_RISK_LOSS_DB)} dB 的风险区间，单声道兼容性良好。`,
        );
      } else {
        const worst = res.intervals.reduce(
          (acc, iv) => (iv.maxLossDb < acc.maxLossDb ? iv : acc),
          res.intervals[0],
        );
        setStatus(
          `立体声/单声道兼容性检查完成：发现 ${n} 个风险区间（${res.totalWindows} 窗，` +
            `安静窗 ${res.quietWindows} 个不参与判定），最大损失 ${worst.maxLossDb.toFixed(2)} dB、` +
            `最差相关度 ${worst.worstCorrelation.toFixed(2)} @ ${fmtTime(worst.startSec)}。` +
            ` 点击区间可载入选区并 A/B 试听原立体声与等权单声道。`,
        );
      }
    };
    worker.onerror = () => {
      if (token !== compatTokenRef.current) return;
      setCompatBusy(false);
      setStatus('立体声/单声道兼容性检查失败：后台线程异常终止。可点击「重新检查」重试。');
    };
    worker.postMessage(
      {
        sampleRate: sr,
        channels,
        options: {
          windowSec: MONO_COMPAT_WINDOW_MS / 1000,
          hopSec: MONO_COMPAT_HOP_MS / 1000,
          quietDbfs: MONO_COMPAT_QUIET_DBFS,
          riskLossDb: MONO_COMPAT_RISK_LOSS_DB,
        },
      },
      channels.map((c) => c.buffer),
    );
  }, [buffer]);

  const handleFile = useCallback(async (file: File) => {
    setBusy(true);
    setStatus('解码中…');
    try {
      const player = getPlayer();
      const buf = await decodeAudioFile(file, player.getContext());
      player.stop();
      setPlaying(null);
      setBuffer(buf);
      setFileName(file.name);
      setSelection(null);
      setCandidates([]);
      setSelectedIdx(0);
      setPeriodCandidates([]);
      setPeriodFailure(null);
      setAppliedPeriod(null);
      setPreSnapSelection(null);
      // 重复片段分析基于旧文件：终止进行中的分析并使过期回包失效
      repeatTokenRef.current++;
      repeatWorkerRef.current?.terminate();
      repeatWorkerRef.current = null;
      setRepeatResult(null);
      setRepeatBusy(false);
      setAppliedRepeatIdx(null);
      // 换文件时清除旧的兼容性检查结果：终止进行中的分析并使过期回包失效
      compatTokenRef.current++;
      compatWorkerRef.current?.terminate();
      compatWorkerRef.current = null;
      setCompatResult(null);
      setCompatBusy(false);
      setAppliedCompatIdx(null);
      const loaded = `已加载：${file.name} — ${buf.sampleRate} Hz / ${buf.numberOfChannels} 声道 / 时长 ${fmtTime(buf.duration)}。`;
      if (buf.numberOfChannels === 2) {
        // 双声道：自动在后台执行兼容性检查
        runMonoCompat(buf, loaded);
      } else {
        setStatus(
          `${loaded} 当前为${buf.numberOfChannels === 1 ? '单声道' : `${buf.numberOfChannels} 声道`}文件，` +
            '立体声/单声道兼容性检查不适用。请在波形上框选大致循环区间。',
        );
      }
    } catch {
      setStatus('解码失败：请使用 WAV / MP3 等浏览器支持的音频格式。');
    } finally {
      setBusy(false);
    }
  }, [runMonoCompat]);

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const onSelectionChange = useCallback(
    (region: Region) => {
      setSelection(region);
      // 选区变化后旧候选失效：清空候选并禁用导出
      setCandidates([]);
      setSelectedIdx(0);
      // 周期候选基于旧选区长度（滞后范围随之变化），一并清空
      setPeriodCandidates([]);
      setPeriodFailure(null);
      // 手动改动选区后，「已载入选区」的重复片段标记随之失效
      setAppliedRepeatIdx(null);
      // 兼容性检查载入选区的风险区间标记同样失效
      setAppliedCompatIdx(null);
      // 手动改变选区长度即解除定长约束（吸附前的选区记录同时作废）
      if (appliedPeriod && buffer) {
        const sr = buffer.sampleRate;
        const lenSamples = (region.end - region.start) * sr;
        if (Math.abs(lenSamples - appliedPeriod.periodSamples) > Math.max(2, sr * 0.0005)) {
          setAppliedPeriod(null);
          setPreSnapSelection(null);
          setStatus('选区长度已改变，定长约束已解除；如需周期校准请重新分析。');
        }
      }
    },
    [appliedPeriod, buffer],
  );

  /** 周期校准：分析整段音频的能量变化包络，给出前 3 个周期候选 */
  const analyzePeriod = useCallback(() => {
    if (!buffer || !selection) {
      setStatus('请先在波形上框选大致循环区间，再进行周期校准。');
      return;
    }
    const res = detectPeriods(buffer, selection.start, selection.end, {
      maxCandidates: MAX_PERIOD_CANDIDATES,
    });
    setPeriodCandidates(res.candidates);
    setPeriodFailure(res.failure);
    if (res.failure === 'too-short') {
      setStatus('周期校准：音频太短，可用范围内无法搜索选区长度 1/2～2 倍的滞后，已保留原选区。');
    } else if (res.failure === 'silence') {
      setStatus('周期校准：音频接近静音（帧能量低于 −80 dBFS），无法提取能量变化包络，已保留原选区。');
    } else if (res.failure === 'no-peak') {
      setStatus(
        `周期校准：未找到显著周期峰（最强归一化自相关 ${res.maxCorrelation.toFixed(2)}，阈值 0.30），已保留原选区。`,
      );
    } else {
      setStatus(
        `周期校准：找到 ${res.candidates.length} 个周期候选（已抑制整数倍/分频重复峰，按置信度排序）。` +
          ` 点击候选将选区终点吸附到该周期，接缝搜索切换为定长约束。`,
      );
    }
  }, [buffer, selection]);

  /** 解除定长约束：恢复吸附前选区，接缝搜索回到自由模式 */
  const releasePeriod = useCallback(() => {
    if (!appliedPeriod) return;
    if (preSnapSelection) setSelection(preSnapSelection);
    setPreSnapSelection(null);
    setAppliedPeriod(null);
    setCandidates([]);
    setSelectedIdx(0);
    setStatus('已解除定长约束并恢复吸附前选区，接缝搜索恢复为自由模式。');
  }, [appliedPeriod, preSnapSelection]);

  /** 选择周期候选：选区终点吸附到该周期，接缝搜索切换为定长约束；再次点击已吸附候选则解除 */
  const applyPeriod = useCallback(
    (cand: PeriodCandidate) => {
      if (!buffer || !selection) return;
      if (appliedPeriod === cand) {
        releasePeriod();
        return;
      }
      const sr = buffer.sampleRate;
      const periodSec = cand.periodSamples / sr;
      const newEnd = selection.start + periodSec;
      if (newEnd > buffer.duration + 1e-9) {
        setStatus(
          `周期 ${(periodSec * 1000).toFixed(1)} ms 超出音频末尾，无法吸附，已保留原选区。`,
        );
        return;
      }
      if (!appliedPeriod) setPreSnapSelection(selection);
      const dEnd = (newEnd - selection.end) * 1000;
      setSelection({ start: selection.start, end: newEnd });
      setAppliedPeriod(cand);
      // 选区已变：旧接缝候选失效
      setCandidates([]);
      setSelectedIdx(0);
      setStatus(
        `已吸附到周期：终点平移 ${dEnd >= 0 ? '+' : ''}${dEnd.toFixed(1)} ms，` +
          `选区长度 = ${(periodSec * 1000).toFixed(1)} ms（${Math.round(cand.periodSamples).toLocaleString()} 采样点，` +
          `置信度 ${(cand.confidence * 100).toFixed(0)}%）。` +
          ` 接缝搜索已切换为定长约束：起止点等量平移，周期样本数不变。`,
      );
    },
    [buffer, selection, appliedPeriod, releasePeriod],
  );

  /** 重复片段发现：在后台 Worker 中提取多频带能量特征并做自相似匹配，不阻塞页面 */
  const analyzeRepeats = useCallback(() => {
    if (!buffer || repeatBusy) return;
    if (!repeatWorkerRef.current) {
      repeatWorkerRef.current = new Worker(
        new URL('./workers/repeatWorker.ts', import.meta.url),
        { type: 'module' },
      );
    }
    const worker = repeatWorkerRef.current;
    const token = ++repeatTokenRef.current;
    const sr = buffer.sampleRate;
    // 复制声道数据并转移所有权（不能转移 AudioBuffer 内部数组，否则波形 / 试听失效）
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      channels.push(buffer.getChannelData(c).slice());
    }
    setRepeatBusy(true);
    setStatus('重复片段发现：后台线程正在提取多频带能量特征并做跨时间自相似匹配，页面可继续操作…');
    worker.onmessage = (e: MessageEvent<RepeatWorkerResponse>) => {
      if (token !== repeatTokenRef.current) return; // 已换文件或重新分析，丢弃过期结果
      setRepeatBusy(false);
      const msg = e.data;
      if (msg.type === 'error') {
        setStatus(`重复片段发现失败：${msg.message}。当前选区未改动。`);
        return;
      }
      const res = msg.result;
      setRepeatResult(res);
      setAppliedRepeatIdx(null);
      const hopMs = ((res.hopSamples / sr) * 1000).toFixed(0);
      if (res.groups.length > 0) {
        const best = res.groups[0];
        setStatus(
          `重复片段发现：找到 ${res.groups.length} 组重复片段（特征帧 ${res.featureFrames}，步长 ${hopMs} ms，按相似度排序）。` +
            ` #1 相似度 ${(best.similarity * 100).toFixed(0)}%。点击任意一行可把较早区间载入波形选区。`,
        );
      } else if (res.failure === 'too-short') {
        setStatus('重复片段发现：音频太短，特征帧不足以容纳两个最短段落，未找到可靠结果，当前选区未改动。');
      } else if (res.failure === 'silence') {
        setStatus('重复片段发现：音频接近静音（帧能量低于 −80 dBFS），无法匹配，当前选区未改动。');
      } else {
        setStatus(
          `重复片段发现：未找到满足条件的重复片段（相似度 ≥ ${(REPEAT_MIN_SIMILARITY * 100).toFixed(0)}%、` +
            `时长 ≥ ${REPEAT_MIN_SEGMENT_SEC} s），当前选区未改动。`,
        );
      }
    };
    worker.onerror = () => {
      if (token !== repeatTokenRef.current) return;
      setRepeatBusy(false);
      setStatus('重复片段发现失败：后台线程异常终止。当前选区未改动。');
    };
    worker.postMessage(
      {
        sampleRate: sr,
        channels,
        options: {
          minSimilarity: REPEAT_MIN_SIMILARITY,
          minSegmentSec: REPEAT_MIN_SEGMENT_SEC,
          maxGroups: MAX_REPEAT_GROUPS,
        },
      },
      channels.map((c) => c.buffer),
    );
  }, [buffer, repeatBusy]);

  /** 点击重复片段：把较早区间载入波形选区，并清空旧周期与接缝候选 */
  const applyRepeat = useCallback(
    (group: RepeatMatch, idx: number) => {
      if (!buffer) return;
      const sr = buffer.sampleRate;
      const start = group.aStartSample / sr;
      const end = group.aEndSample / sr;
      setSelection({ start, end });
      setAppliedRepeatIdx(idx);
      // 选区来源已变：旧接缝候选与周期校准结果一并清空
      setCandidates([]);
      setSelectedIdx(0);
      setPeriodCandidates([]);
      setPeriodFailure(null);
      setAppliedPeriod(null);
      setPreSnapSelection(null);
      setStatus(
        `已载入重复片段 #${idx + 1} 的较早区间 ${fmtTime(start)} ~ ${fmtTime(end)}` +
          `（时长 ${fmtTime(end - start)}，相似度 ${(group.similarity * 100).toFixed(0)}%）为当前选区；` +
          `旧周期与接缝候选已清空，可直接「查找候选接缝」或「分析周期」。`,
      );
    },
    [buffer],
  );

  /** 试听指定风险区间：mode = 'stereo' 为原立体声，'mono' 为等权（L+R)/2 单声道，循环播放 */
  const playCompatInterval = useCallback(async (iv: MonoCompatInterval, mode: 'compat-stereo' | 'compat-mono') => {
    if (!buffer) return;
    const sr = buffer.sampleRate;
    const s0 = Math.max(0, Math.round(iv.startSample));
    const e0 = Math.min(buffer.length, Math.round(iv.endSample));
    if (e0 - s0 < 2) return;
    let pcm = buildLoopPcm(buffer, s0, e0, 0);
    if (mode === 'compat-mono') {
      // 等权合并单声道：与风险判定口径一致 m = (L + R) / 2
      const n = pcm.channels[0].length;
      const mono = new Float32Array(n);
      const ch0 = pcm.channels[0];
      const ch1 = pcm.channels[1] ?? ch0;
      for (let i = 0; i < n; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
      pcm = { sampleRate: sr, channels: [mono] };
    }
    await getPlayer().play(pcm);
    setPlaying(mode);
  }, [buffer]);

  /** 点击风险区间：载入波形选区并清空旧周期与接缝候选（试听模式若在进行则延续到新区间） */
  const applyCompatInterval = useCallback(
    async (idx: number) => {
      if (!buffer || !compatResult) return;
      const iv = compatResult.intervals[idx];
      if (!iv) return;
      const { startSec: start, endSec: end } = iv;
      // 记录切换前的试听模式：切换区间后无缝续播，便于连续核对
      const resume: MonoCompatPlayTarget =
        playing === 'compat-stereo' || playing === 'compat-mono' ? playing : null;
      setSelection({ start, end });
      setAppliedCompatIdx(idx);
      // 选区来源已变：旧接缝候选与周期校准结果一并清空
      setCandidates([]);
      setSelectedIdx(0);
      setPeriodCandidates([]);
      setPeriodFailure(null);
      setAppliedPeriod(null);
      setPreSnapSelection(null);
      if (resume) {
        await playCompatInterval(iv, resume);
      }
      setStatus(
        `已载入兼容性风险区间 #${idx + 1} ${fmtTime(start)} ~ ${fmtTime(end)}` +
          `（时长 ${fmtTime(end - start)}，${iv.windowCount} 个风险窗，` +
          `最差相关度 ${iv.worstCorrelation.toFixed(2)}，最大损失 ${iv.maxLossDb.toFixed(2)} dB）；` +
          `可切换试听原立体声与等权单声道核对抵消。`,
      );
    },
    [buffer, compatResult, playing, playCompatInterval],
  );

  /** 搜索半径变化：清空候选并禁用旧导出，需重新查找 */
  const onRadiusChange = (v: number) => {
    setRadiusMs(v);
    if (candidates.length > 0) {
      setStatus('搜索半径已调整，候选接缝已清空，请重新查找。');
    }
    setCandidates([]);
    setSelectedIdx(0);
  };

  /** 执行候选接缝搜索；返回候选列表（失败返回空数组） */
  const runSearch = useCallback((): SeamResult[] => {
    if (!buffer || !selection) {
      setStatus('请先在波形上框选大致循环区间。');
      return [];
    }
    const sr = buffer.sampleRate;
    const startS = selection.start * sr;
    const endS = selection.end * sr;
    if (endS - startS < MIN_LOOP_SECONDS * sr) {
      setStatus('选区太短，请框选更长的循环区间。');
      return [];
    }
    const maxRadius = Math.max(1, (endS - startS) / 2 - 64);
    const radius = Math.min((radiusMs / 1000) * sr, maxRadius);
    const found = findCandidateSeams(buffer, startS, endS, {
      radiusSamples: radius,
      slopeWindow: SLOPE_WINDOW,
      slopeWeight: SLOPE_WEIGHT,
      maxCandidates: MAX_CANDIDATES,
      fixedLoopSamples: fixedLoopSamples ?? undefined,
    });
    setCandidates(found);
    setSelectedIdx(0);
    if (found.length === 0) {
      setStatus(
        fixedLoopSamples !== null
          ? '未找到有效接缝：定长周期下可搜索范围为空，请调整选区、增大搜索半径或解除定长约束。'
          : '未找到有效接缝：请调整选区或增大搜索半径。',
      );
      return found;
    }
    const best = found[0];
    const dStart = ((best.startSample - startS) / sr) * 1000;
    const dEnd = ((best.endSample - endS) / sr) * 1000;
    if (fixedLoopSamples !== null) {
      // 定长模式：起止点等量平移，仅需报告一个平移量
      setStatus(
        `定长搜索（${fixedLoopSamples.toLocaleString()} 采样点，起止点等量平移）：` +
          `找到 ${found.length} 个候选接缝（起止点相距不足 10 ms 的已去重，按代价排序）。` +
          ` #1 平移 ${dStart >= 0 ? '+' : ''}${dStart.toFixed(1)} ms，代价 ${best.cost.toFixed(4)}。` +
          ` 点击候选列表可切换试听与导出目标。`,
      );
      return found;
    }
    setStatus(
      `找到 ${found.length} 个候选接缝（起止点相距不足 10 ms 的已去重，按代价排序）。` +
        ` #1 起点移动 ${dStart >= 0 ? '+' : ''}${dStart.toFixed(1)} ms，` +
        `终点移动 ${dEnd >= 0 ? '+' : ''}${dEnd.toFixed(1)} ms，代价 ${best.cost.toFixed(4)}。` +
        ` 点击候选列表可切换试听与导出目标。`,
    );
    return found;
  }, [buffer, selection, radiusMs, fixedLoopSamples]);

  const playOriginal = useCallback(async () => {
    if (!buffer || !selection) {
      setStatus('请先框选循环区间。');
      return;
    }
    const sr = buffer.sampleRate;
    const pcm = buildLoopPcm(buffer, selection.start * sr, selection.end * sr, 0);
    await getPlayer().play(pcm);
    setPlaying('original');
  }, [buffer, selection]);

  /** 循环试听指定候选（idx 缺省为当前选中项；无候选时先自动搜索） */
  const playCandidate = useCallback(
    async (list: SeamResult[], idx: number) => {
      if (!buffer) return;
      const s = list[idx];
      if (!s) return;
      const pcm = buildLoopPcm(buffer, s.startSample, s.endSample, (crossfadeMs / 1000) * buffer.sampleRate);
      await getPlayer().play(pcm);
      setPlaying('optimized');
    },
    [buffer, crossfadeMs],
  );

  const playOptimized = useCallback(async () => {
    if (!buffer) return;
    let list = candidates;
    let idx = selectedIdx;
    if (list.length === 0) {
      list = runSearch();
      idx = 0;
    }
    await playCandidate(list, idx);
  }, [buffer, candidates, selectedIdx, runSearch, playCandidate]);

  /** 点选候选：设为导出目标并循环试听；再次点击正在试听的候选则停止 */
  const onCandidateClick = useCallback(
    async (idx: number) => {
      if (idx === selectedIdx && playing === 'optimized') {
        getPlayer().stop();
        setPlaying(null);
        return;
      }
      setSelectedIdx(idx);
      await playCandidate(candidates, idx);
    },
    [candidates, selectedIdx, playing, playCandidate],
  );

  const stopPlayback = useCallback(() => {
    getPlayer().stop();
    setPlaying(null);
  }, []);

  /** 兼容性检查面板：再点当前模式按钮则停止，否则在已载入区间上切换原立体声 / 等权单声道 */
  const playCompatMode = useCallback(
    async (mode: 'compat-stereo' | 'compat-mono') => {
      if (!compatResult || appliedCompatIdx === null) {
        setStatus('请先点击一个风险区间将其载入选区，再切换试听。');
        return;
      }
      const iv = compatResult.intervals[appliedCompatIdx];
      if (!iv) return;
      if (playing === mode) {
        getPlayer().stop();
        setPlaying(null);
        return;
      }
      await playCompatInterval(iv, mode);
    },
    [compatResult, appliedCompatIdx, playing, playCompatInterval],
  );

  // 交叉淡化时长变化时，若正在试听优化区间则实时重建并继续播放
  const crossfadeRef = useRef(crossfadeMs);
  useEffect(() => {
    if (crossfadeRef.current === crossfadeMs) return;
    crossfadeRef.current = crossfadeMs;
    if (playing === 'optimized') void playOptimized();
  }, [crossfadeMs, playing, playOptimized]);

  const exportJson = useCallback(() => {
    if (!buffer || !selection || !seam) return;
    const sr = buffer.sampleRate;
    const payload = {
      file: fileName,
      sampleRate: sr,
      channels: buffer.numberOfChannels,
      durationSec: buffer.duration,
      original: {
        startSec: selection.start,
        endSec: selection.end,
        startSample: Math.round(selection.start * sr),
        endSample: Math.round(selection.end * sr),
      },
      optimized: {
        startSec: seam.startSample / sr,
        endSec: seam.endSample / sr,
        startSample: seam.startSample,
        endSample: seam.endSample,
      },
      loopDurationSec: (seam.endSample - seam.startSample) / sr,
      candidates: candidates.map((c, i) => ({
        rank: i + 1,
        startSec: c.startSample / sr,
        endSec: c.endSample / sr,
        startSample: c.startSample,
        endSample: c.endSample,
        cost: c.cost,
      })),
      selectedCandidate: selectedIdx + 1,
      parameters: {
        searchRadiusMs: radiusMs,
        crossfadeMs,
        slopeWindowSamples: SLOPE_WINDOW,
        slopeWeight: SLOPE_WEIGHT,
        // 定长搜索标记：周期校准吸附后为 true，起止点等量平移、循环长度固定
        fixedLengthSearch: fixedLoopSamples !== null,
        fixedLoopSamples,
      },
      // 周期校准：吸附的周期、置信度与全部周期候选；未校准时为 null
      periodCalibration: appliedPeriod
        ? {
            applied: true,
            fixedLengthSearch: true,
            periodSec: roundTo(appliedPeriod.periodSamples / sr, 6),
            periodSamples: Math.round(appliedPeriod.periodSamples),
            confidence: roundTo(appliedPeriod.confidence, 4),
            correlation: roundTo(appliedPeriod.correlation, 4),
            candidates: periodCandidates.map((c, i) => ({
              rank: i + 1,
              periodSec: roundTo(c.periodSamples / sr, 6),
              periodSamples: Math.round(c.periodSamples),
              confidence: roundTo(c.confidence, 4),
              correlation: roundTo(c.correlation, 4),
            })),
          }
        : null,
      // 重复片段发现：后台自相似分析的参数与结果；未分析时为 null
      repeatSegments: repeatResult
        ? {
            parameters: {
              frameMs: roundTo((repeatResult.frameSamples / sr) * 1000, 3),
              hopMs: roundTo((repeatResult.hopSamples / sr) * 1000, 3),
              featureFrames: repeatResult.featureFrames,
              bands: repeatResult.bands,
              minSimilarity: REPEAT_MIN_SIMILARITY,
              minSegmentSec: REPEAT_MIN_SEGMENT_SEC,
              maxGroups: MAX_REPEAT_GROUPS,
            },
            groups: repeatResult.groups.map((g, i) => ({
              rank: i + 1,
              a: {
                startSec: roundTo(g.aStartSample / sr, 6),
                endSec: roundTo(g.aEndSample / sr, 6),
                startSample: g.aStartSample,
                endSample: g.aEndSample,
              },
              b: {
                startSec: roundTo(g.bStartSample / sr, 6),
                endSec: roundTo(g.bEndSample / sr, 6),
                startSample: g.bStartSample,
                endSample: g.bEndSample,
              },
              durationSec: roundTo((g.aEndSample - g.aStartSample) / sr, 6),
              similarity: roundTo(g.similarity, 4),
            })),
          }
        : null,
      seamCost: seam.cost,
      // 接缝频谱诊断：参数与结果（差值矩阵为 头 − 尾，帧按与接缝的距离配对）
      spectrumDiagnostics: spectrum
        ? {
            candidate: selectedIdx + 1,
            parameters: {
              windowMsRequested: specWindowMs,
              windowMsEffective: roundTo((spectrum.windowSamples / spectrum.sampleRate) * 1000, 3),
              windowClamped: spectrum.clamped,
              windowFunction: 'hann',
              fftSize: spectrum.fftSize,
              hopSamples: spectrum.hopSamples,
              overlapRatio: 0.75,
              bandCount: spectrum.bands,
              bandEdgesHz: spectrum.bandEdgesHz.map((f) => roundTo(f, 1)),
              frameCount: spectrum.frameOffsetsSec.length,
              alignment: 'seam-distance',
              diff: 'headDb-tailDb',
            },
            results: {
              maxAbsDiffDb: roundTo(spectrum.maxAbsDiffDb, 2),
              worstBand: spectrum.worstBand + 1,
              worstBandHz: [
                roundTo(spectrum.bandEdgesHz[spectrum.worstBand], 1),
                roundTo(spectrum.bandEdgesHz[spectrum.worstBand + 1], 1),
              ],
              bandMaxAbsDb: spectrum.bandMaxAbsDb.map((v) => roundTo(v, 2)),
              frameOffsetsMs: spectrum.frameOffsetsSec.map((t) => roundTo(t * 1000, 1)),
              diffDb: spectrum.diffDb.map((row) => row.map((v) => roundTo(v, 2))),
            },
          }
        : null,
      // 立体声/单声道兼容性检查：参数、窗统计与风险区间；单声道 / 多声道文件 applicable=false
      monoCompatibility: compatResult
        ? {
            applicable: compatResult.applicable,
            failure: compatResult.failure,
            parameters: {
              windowMs: MONO_COMPAT_WINDOW_MS,
              hopMs: MONO_COMPAT_HOP_MS,
              windowSamples: compatResult.windowSamples,
              hopSamples: compatResult.hopSamples,
              quietThresholdDbfs: MONO_COMPAT_QUIET_DBFS,
              riskLossDb: MONO_COMPAT_RISK_LOSS_DB,
              monoMix: 'equal-gain-(L+R)/2',
            },
            totalWindows: compatResult.totalWindows,
            quietWindows: compatResult.quietWindows,
            riskWindows: compatResult.riskWindows,
            intervals: compatResult.intervals.map((iv, i) => ({
              rank: i + 1,
              startSec: roundTo(iv.startSec, 6),
              endSec: roundTo(iv.endSec, 6),
              startSample: iv.startSample,
              endSample: iv.endSample,
              durationSec: roundTo(iv.endSec - iv.startSec, 6),
              windowCount: iv.windowCount,
              worstCorrelation: roundTo(iv.worstCorrelation, 4),
              maxLossDb: roundTo(iv.maxLossDb, 2),
            })),
          }
        : {
            applicable: buffer.numberOfChannels === 2,
            failure: buffer.numberOfChannels === 2 ? 'not-analyzed' : 'not-stereo',
            intervals: [],
          },
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName.replace(/\.[^.]+$/, '') || 'loop'}.loop.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(
      `已导出 JSON：候选 #${selectedIdx + 1} 的起止时间、全部候选列表、搜索参数与接缝频谱诊断` +
        (appliedPeriod ? '，含周期校准（周期、置信度与定长搜索标记）' : '') +
        (repeatResult ? `，含 ${repeatResult.groups.length} 组重复片段` : '') +
        (compatResult ? `，含 ${compatResult.intervals.length} 个单声道兼容性风险区间` : '') +
        '。',
    );
  }, [buffer, selection, seam, candidates, selectedIdx, fileName, radiusMs, crossfadeMs, spectrum, specWindowMs, appliedPeriod, periodCandidates, fixedLoopSamples, repeatResult, compatResult]);

  const exportWav = useCallback(() => {
    if (!buffer || !seam) return;
    const pcm = buildLoopPcm(buffer, seam.startSample, seam.endSample, (crossfadeMs / 1000) * buffer.sampleRate);
    const wav = encodeWav(pcm);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName.replace(/\.[^.]+$/, '') || 'loop'}.loop.wav`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(
      `已导出 WAV（候选 #${selectedIdx + 1}）：16-bit PCM，含 smpl 循环区块（0 → 最后一帧），共 ${fmtBytes(wav.byteLength)}。`,
    );
  }, [buffer, seam, selectedIdx, crossfadeMs, fileName]);

  const sr = buffer?.sampleRate ?? 44100;

  // 波形上的候选标记（编号与候选列表对应）
  const candidateMarkers: SeamMarker[] = candidates.map((c, i) => ({
    start: c.startSample / sr,
    end: c.endSample / sr,
    label: String(i + 1),
    selected: i === selectedIdx,
  }));

  // 导出 WAV 的帧数与预计大小（与 buildLoopPcm 的边界夹取逻辑保持一致；
  // 交叉淡化只改写接缝区域，不改变总帧数）
  let wavFrames = 0;
  let wavBytes = 0;
  if (buffer && seam) {
    const len = buffer.length;
    const s = Math.max(0, Math.min(Math.round(seam.startSample), len - 2));
    const e = Math.max(s + 2, Math.min(Math.round(seam.endSample), len));
    wavFrames = e - s;
    wavBytes = wavFileSize(wavFrames, buffer.numberOfChannels);
  }

  return (
    <div className="app">
      <header className="header">
        <h1>无缝循环接缝查找器</h1>
        <p>本地浏览器内分析音频：可自动发现整段音频中的重复片段并载入选区，先做周期校准吸附选区终点（定长接缝搜索），在粗选边界附近搜索幅值与短窗斜率最连续的接缝候选（Top 5 按代价排序），可点选对比试听、查看接缝频谱诊断热图并导出参数。</p>
      </header>

      <section
        className={`dropzone${dragOver ? ' dragover' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,.wav,.mp3"
          style={{ display: 'none' }}
          onChange={onInputChange}
        />
        <strong>{busy ? '解码中…' : fileName || '点击选择或拖入 WAV / MP3 文件'}</strong>
        <span>{fileName ? '点击可重新选择文件' : '音频不会上传，全部在本地处理'}</span>
      </section>

      {buffer && (
        <>
          <Waveform buffer={buffer} selection={selection} markers={candidateMarkers} onSelectionChange={onSelectionChange} />
          <div className="legend">
            <span><i className="swatch swatch-handle" /> 选区边界（可拖动）</span>
            <span><i className="swatch swatch-seam" /> 候选接缝（编号与列表对应，高亮为选中）</span>
          </div>

          <MonoCompatPanel
            channelCount={buffer.numberOfChannels}
            result={compatResult}
            busy={compatBusy}
            appliedIdx={appliedCompatIdx}
            playing={playing === 'compat-stereo' || playing === 'compat-mono' ? (playing as MonoCompatPlayTarget) : null}
            onReanalyze={() => runMonoCompat()}
            onSelectInterval={(idx) => void applyCompatInterval(idx)}
            onPlayStereo={() => void playCompatMode('compat-stereo')}
            onPlayMono={() => void playCompatMode('compat-mono')}
            onStop={stopPlayback}
          />

          <section className="panel repeats">
            <h2>重复片段发现</h2>
            <p className="repeats-desc">
              在后台线程对整段音频提取固定步长的多频带能量特征，构建跨时间自相似匹配并沿对角线合并连续命中，
              过滤自匹配、区间重叠与过短段落后列出最多 5 组重复片段（两个区间、持续时间与相似度），分析不阻塞页面。
              点击任意结果可把较早区间载入波形选区（旧周期与接缝候选随之清空）；无可靠结果时给出明确提示且不改变当前选区。
            </p>
            <div className="transport">
              <button className="primary" onClick={analyzeRepeats} disabled={repeatBusy}>
                {repeatBusy ? '分析中…' : '发现重复片段'}
              </button>
            </div>
            {repeatResult && repeatResult.groups.length === 0 && (
              <p className="clamp-note">
                {repeatResult.failure === 'too-short' &&
                  '音频太短：特征帧不足以容纳两个最短段落，未找到可靠的重复片段。'}
                {repeatResult.failure === 'silence' &&
                  '音频接近静音：帧能量低于 −80 dBFS，无法进行自相似匹配。'}
                {(repeatResult.failure === 'no-match' || repeatResult.failure === null) &&
                  `未找到满足条件的重复片段（相似度 ≥ ${(REPEAT_MIN_SIMILARITY * 100).toFixed(0)}%、时长 ≥ ${REPEAT_MIN_SEGMENT_SEC} s）。`}
                当前选区未改动。
              </p>
            )}
            {repeatResult && repeatResult.groups.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>区间 A（较早）</th>
                    <th>区间 B（较晚）</th>
                    <th>持续时间</th>
                    <th>相似度</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {repeatResult.groups.map((g, i) => (
                    <tr
                      key={i}
                      className={i === appliedRepeatIdx ? 'selected' : ''}
                      onClick={() => applyRepeat(g, i)}
                    >
                      <td><span className="rank">{i + 1}</span></td>
                      <td>{fmtTime(g.aStartSample / sr)} – {fmtTime(g.aEndSample / sr)}</td>
                      <td>{fmtTime(g.bStartSample / sr)} – {fmtTime(g.bEndSample / sr)}</td>
                      <td>{fmtTime((g.aEndSample - g.aStartSample) / sr)}</td>
                      <td>
                        <span className="conf">
                          <span className="conf-fill" style={{ width: `${Math.round(g.similarity * 100)}%` }} />
                        </span>
                        {(g.similarity * 100).toFixed(0)}%
                      </td>
                      <td className="row-state">
                        {i === appliedRepeatIdx ? '✓ 已载入选区' : '点击载入较早区间'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="panel period">
            <h2>周期校准</h2>
            <p className="period-desc">
              将整段音频混合为单声道并提取短时能量变化包络，在可用音频范围内对选区长度 1/2～2 倍的滞后做归一化自相关，
              抑制整数倍/分频重复峰后给出前 3 个周期候选及置信度。点击候选把选区终点吸附到该周期，
              此后接缝搜索改为定长约束（起止点等量平移，周期样本数不变）；短音频、静音或无显著峰时不强制吸附。
            </p>
            <div className="transport">
              <button className="primary" onClick={analyzePeriod} disabled={!selection}>分析周期</button>
              {appliedPeriod && <button onClick={releasePeriod}>解除定长约束</button>}
            </div>
            {periodFailure && (
              <p className="clamp-note">
                {periodFailure === 'too-short' &&
                  '音频太短：可用范围内无法搜索选区长度 1/2～2 倍的滞后，未强制吸附，已保留原选区。'}
                {periodFailure === 'silence' &&
                  '音频接近静音：能量变化包络过低，无法进行周期校准，未强制吸附，已保留原选区。'}
                {periodFailure === 'no-peak' &&
                  '无显著周期峰：归一化自相关低于阈值，未强制吸附，已保留原选区。'}
              </p>
            )}
            {periodCandidates.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>周期</th>
                    <th>采样点</th>
                    <th>置信度</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {periodCandidates.map((c, i) => {
                    const applied = appliedPeriod === c;
                    return (
                      <tr key={i} className={applied ? 'selected' : ''} onClick={() => applyPeriod(c)}>
                        <td><span className="rank">{i + 1}</span></td>
                        <td>{((c.periodSamples / sr) * 1000).toFixed(1)} ms</td>
                        <td>{Math.round(c.periodSamples).toLocaleString()}</td>
                        <td>
                          <span className="conf">
                            <span className="conf-fill" style={{ width: `${Math.round(c.confidence * 100)}%` }} />
                          </span>
                          {(c.confidence * 100).toFixed(0)}%
                        </td>
                        <td className="row-state">{applied ? '✓ 已吸附（再点解除）' : '点击吸附到该周期'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {appliedPeriod && (
              <p className="period-note">
                定长约束生效中：循环长度固定为 {Math.round(appliedPeriod.periodSamples).toLocaleString()} 采样点
                （{((appliedPeriod.periodSamples / sr) * 1000).toFixed(1)} ms，
                置信度 {(appliedPeriod.confidence * 100).toFixed(0)}%），
                接缝搜索时起点与终点等量平移；搜索半径、候选去重与试听流程不变。
              </p>
            )}
          </section>

          <section className="panel">
            <div className="sliders">
              <label>
                <span>搜索半径：<b>{radiusMs} ms</b></span>
                <input
                  type="range"
                  min={5}
                  max={500}
                  step={5}
                  value={radiusMs}
                  onChange={(e) => onRadiusChange(Number(e.target.value))}
                />
              </label>
              <label>
                <span>交叉淡化：<b>{crossfadeMs} ms</b></span>
                <input
                  type="range"
                  min={0}
                  max={500}
                  step={5}
                  value={crossfadeMs}
                  onChange={(e) => setCrossfadeMs(Number(e.target.value))}
                />
              </label>
            </div>

            <div className="transport">
              <button className="primary" onClick={() => runSearch()}>查找候选接缝</button>
              <button
                className={playing === 'original' ? 'active' : ''}
                onClick={() => (playing === 'original' ? stopPlayback() : void playOriginal())}
              >
                {playing === 'original' ? '■ 停止' : '▶ 试听原区间'}
              </button>
              <button
                className={playing === 'optimized' ? 'active' : ''}
                onClick={() => (playing === 'optimized' ? stopPlayback() : void playOptimized())}
              >
                {playing === 'optimized' ? '■ 停止' : '▶ 试听选中候选'}
              </button>
              <button onClick={stopPlayback} disabled={playing === null}>停止</button>
              <button onClick={exportJson} disabled={!seam || !selection}>下载 JSON</button>
              <button onClick={exportWav} disabled={!seam}>下载 WAV</button>
            </div>

            {seam && buffer && (
              <p className="export-info">
                WAV 导出（候选 #{selectedIdx + 1}）：{buffer.sampleRate} Hz · {buffer.numberOfChannels} 声道 ·{' '}
                {wavFrames.toLocaleString()} 帧 · 预计 {fmtBytes(wavBytes)}
                （16-bit PCM，含 smpl 循环区块）
              </p>
            )}
          </section>

          {candidates.length > 0 && (
            <section className="panel candidates">
              <h2>候选接缝（按代价排序）— 点击行循环试听，选中项即为导出目标</h2>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>起点</th>
                    <th>终点</th>
                    <th>循环时长</th>
                    <th>代价</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c, i) => (
                    <tr
                      key={i}
                      className={i === selectedIdx ? 'selected' : ''}
                      onClick={() => void onCandidateClick(i)}
                    >
                      <td><span className="rank">{i + 1}</span></td>
                      <td>{fmtTime(c.startSample / sr)}</td>
                      <td>{fmtTime(c.endSample / sr)}</td>
                      <td>{fmtTime((c.endSample - c.startSample) / sr)}</td>
                      <td>{c.cost.toFixed(4)}</td>
                      <td className="row-state">
                        {i === selectedIdx
                          ? playing === 'optimized'
                            ? '■ 试听中（再点停止）'
                            : '✓ 导出目标'
                          : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {seam && buffer && (
            <SeamSpectrumPanel
              result={spectrum}
              candidateLabel={`候选 #${selectedIdx + 1}`}
              windowMs={specWindowMs}
              onWindowMsChange={setSpecWindowMs}
            />
          )}

          <section className="panel info">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>起点</th>
                  <th>终点</th>
                  <th>循环时长</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>原区间</td>
                  <td>{selection ? fmtTime(selection.start) : '—'}</td>
                  <td>{selection ? fmtTime(selection.end) : '—'}</td>
                  <td>{selection ? fmtTime(selection.end - selection.start) : '—'}</td>
                </tr>
                <tr className="optimized-row">
                  <td>优化区间{seam ? `（候选 #${selectedIdx + 1}）` : ''}</td>
                  <td>{seam ? fmtTime(seam.startSample / sr) : '—'}</td>
                  <td>{seam ? fmtTime(seam.endSample / sr) : '—'}</td>
                  <td>{seam ? fmtTime((seam.endSample - seam.startSample) / sr) : '—'}</td>
                </tr>
              </tbody>
            </table>
            {seam && (
              <p className="cost">
                接缝代价：{seam.cost.toFixed(4)}（候选 #{selectedIdx + 1}，越小越平滑） · 淡化 {crossfadeMs} ms · 半径 {radiusMs} ms
                {fixedLoopSamples !== null && ` · 定长 ${fixedLoopSamples.toLocaleString()} 采样`}
              </p>
            )}
          </section>
        </>
      )}

      <p className="status">{status}</p>

      <footer className="footer">
        所有音频处理均在浏览器本地完成（Web Audio API），不会上传任何数据。
      </footer>
    </div>
  );
}
