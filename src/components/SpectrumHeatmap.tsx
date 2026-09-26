import { useEffect, useMemo, useRef, useState } from 'react';
import type { SeamSpectrumResult } from '../audio/seamSpectrum';

interface SpectrumHeatmapProps {
  result: SeamSpectrumResult;
  /** 颜色量程（±dB，对称） */
  rangeDb: number;
}

const HEIGHT = 240;
/** 左侧频带标签区宽度 */
const ML = 88;
/** 右侧色条区宽度 */
const MR = 60;
const MT = 10;
const MB = 28;
/** 最大放大倍数 */
const MAX_ZOOM = 64;

// 发散色标：负 → 蓝，0 → 深底，正 → 红
const C_NEG = [63, 131, 248] as const;
const C_ZERO = [21, 27, 43] as const;
const C_POS = [239, 96, 84] as const;

function diffColor(v: number, range: number): string {
  let t = v / range;
  if (t > 1) t = 1;
  else if (t < -1) t = -1;
  const a = C_ZERO;
  const b = t >= 0 ? C_POS : C_NEG;
  const k = Math.abs(t);
  const r = Math.round(a[0] + (b[0] - a[0]) * k);
  const g = Math.round(a[1] + (b[1] - a[1]) * k);
  const bl = Math.round(a[2] + (b[2] - a[2]) * k);
  return `rgb(${r},${g},${bl})`;
}

/** 频率 → 紧凑标签（如 940 → "940"，2070 → "2.1k"） */
export function fmtFreq(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${Math.round(hz)}`;
}

const NICE_STEPS_MS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

/**
 * 接缝频谱差热图：横轴为帧中心距接缝的时间（ms，左侧为接缝），
 * 纵轴为对数频带（低端在下）。滚轮缩放、拖拽平移、双击复位。
 */
export function SpectrumHeatmap({ result, rangeDb }: SpectrumHeatmapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  /** 可视窗口（内容宽度的分数）：x = 左缘，w = 宽度 */
  const [view, setView] = useState({ x: 0, w: 1 });
  const [hover, setHover] = useState<{ frame: number; band: number } | null>(null);
  const dragRef = useRef<{ startX: number; viewX: number } | null>(null);

  const frames = result.frameOffsetsSec.length;
  const bands = result.bands;
  /** 每帧中心距接缝的 ms（横轴刻度用） */
  const offsetsMs = useMemo(() => result.frameOffsetsSec.map((t) => t * 1000), [result]);

  // 容器宽度自适应
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(Math.max(0, Math.floor(entry.contentRect.width)));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 新结果（切换候选 / 淡化 / 窗长）时复位缩放与悬停
  useEffect(() => {
    setView({ x: 0, w: 1 });
    setHover(null);
  }, [result]);

  // 滚轮缩放（需要非 passive 监听才能 preventDefault 阻止页面滚动）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const plotW = rect.width - ML - MR;
      if (plotW <= 0) return;
      const p = Math.max(0, Math.min(1, (e.clientX - rect.left - ML) / plotW));
      setView((v) => {
        const factor = e.deltaY < 0 ? 1 / 1.3 : 1.3;
        const w = Math.max(1 / MAX_ZOOM, Math.min(1, v.w * factor));
        const anchor = v.x + p * v.w;
        const x = Math.max(0, Math.min(1 - w, anchor - p * w));
        return { x, w };
      });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  // 绘制
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = HEIGHT * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#0e1320';
    ctx.fillRect(0, 0, width, HEIGHT);

    const plotW = width - ML - MR;
    const plotH = HEIGHT - MT - MB;
    if (plotW <= 0 || plotH <= 0) return;
    const rowH = plotH / bands;

    // ---- 热图单元格（裁剪到绘图区）----
    ctx.save();
    ctx.beginPath();
    ctx.rect(ML, MT, plotW, plotH);
    ctx.clip();
    for (let f = 0; f < frames; f++) {
      const x0 = ML + ((f / frames - view.x) / view.w) * plotW;
      const x1 = ML + (((f + 1) / frames - view.x) / view.w) * plotW;
      if (x1 < ML || x0 > ML + plotW) continue;
      const row = result.diffDb[f];
      for (let b = 0; b < bands; b++) {
        ctx.fillStyle = diffColor(row[b], rangeDb);
        ctx.fillRect(x0, MT + (bands - 1 - b) * rowH, Math.max(1, x1 - x0) + 0.5, rowH + 0.5);
      }
    }
    // 频带分隔线
    ctx.fillStyle = 'rgba(230,235,245,0.07)';
    for (let b = 1; b < bands; b++) {
      ctx.fillRect(ML, MT + b * rowH, plotW, 1);
    }
    // 悬停单元格高亮
    if (hover && hover.frame < frames && hover.band < bands) {
      const x0 = ML + ((hover.frame / frames - view.x) / view.w) * plotW;
      const x1 = ML + (((hover.frame + 1) / frames - view.x) / view.w) * plotW;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0, MT + (bands - 1 - hover.band) * rowH, Math.max(2, x1 - x0), rowH);
    }
    ctx.restore();

    // ---- 绘图区边框 ----
    ctx.strokeStyle = '#232c40';
    ctx.lineWidth = 1;
    ctx.strokeRect(ML + 0.5, MT + 0.5, plotW - 1, plotH - 1);

    // ---- 纵轴：频带标签（低端在下）----
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(230,235,245,0.55)';
    for (let b = 0; b < bands; b++) {
      const y = MT + (bands - 1 - b) * rowH + rowH / 2;
      ctx.fillText(
        `${fmtFreq(result.bandEdgesHz[b])}–${fmtFreq(result.bandEdgesHz[b + 1])}`,
        ML - 6,
        y,
      );
    }

    // ---- 横轴：距接缝时间刻度（帧中心位置按线性插值映射）----
    const fracToMs = (p: number): number => {
      const fi = p * frames - 0.5;
      if (fi <= 0) return offsetsMs[0];
      if (fi >= frames - 1) return offsetsMs[frames - 1];
      const i = Math.floor(fi);
      return offsetsMs[i] + (offsetsMs[i + 1] - offsetsMs[i]) * (fi - i);
    };
    const msToFrac = (ms: number): number => {
      if (ms <= offsetsMs[0]) return 0.5 / frames;
      for (let i = 1; i < frames; i++) {
        if (offsetsMs[i] >= ms) {
          const t = (ms - offsetsMs[i - 1]) / (offsetsMs[i] - offsetsMs[i - 1] || 1);
          return (i - 1 + t + 0.5) / frames;
        }
      }
      return (frames - 0.5) / frames;
    };
    const visMs0 = fracToMs(view.x);
    const visMs1 = fracToMs(view.x + view.w);
    const step = NICE_STEPS_MS.find((s) => s >= (visMs1 - visMs0) / 4) ?? 2000;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(230,235,245,0.45)';
    for (let t = Math.ceil(visMs0 / step) * step; t <= visMs1 + 1e-9; t += step) {
      const x = ML + ((msToFrac(t) - view.x) / view.w) * plotW;
      if (x < ML - 1 || x > ML + plotW + 1) continue;
      ctx.fillRect(Math.round(x) + 0.5, MT + plotH, 1, 4);
      ctx.fillText(`${t % 1 === 0 ? t : t.toFixed(1)}`, x, MT + plotH + 14);
    }
    // 横轴标题
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(230,235,245,0.35)';
    ctx.fillText('距接缝 ms', ML + plotW, HEIGHT - 4);

    // ---- 右侧色条 ----
    const cbX = ML + plotW + 14;
    const cbW = 10;
    const strips = 32;
    for (let i = 0; i < strips; i++) {
      const t = i / strips;
      ctx.fillStyle = diffColor(rangeDb * (1 - 2 * (t + 0.5 / strips)), rangeDb);
      ctx.fillRect(cbX, MT + t * plotH, cbW, plotH / strips + 1);
    }
    ctx.strokeStyle = '#232c40';
    ctx.strokeRect(cbX + 0.5, MT + 0.5, cbW - 1, plotH - 1);
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(230,235,245,0.55)';
    ctx.fillText(`+${rangeDb}`, cbX + cbW + 4, MT + 5);
    ctx.fillText('0', cbX + cbW + 4, MT + plotH / 2);
    ctx.fillText(`−${rangeDb}`, cbX + cbW + 4, MT + plotH - 5);
    ctx.textAlign = 'center';
    ctx.fillText('dB', cbX + cbW / 2, MT - 4 + 1);
  }, [result, rangeDb, view, width, hover, frames, bands, offsetsMs]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (view.w >= 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, viewX: view.x };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const plotW = rect.width - ML - MR;
    const plotH = HEIGHT - MT - MB;
    if (plotW <= 0 || plotH <= 0) return;
    const drag = dragRef.current;
    if (drag && view.w < 1) {
      const dx = ((e.clientX - drag.startX) / plotW) * view.w;
      setView((v) => ({ ...v, x: Math.max(0, Math.min(1 - v.w, drag.viewX - dx)) }));
      return;
    }
    // 悬停定位：帧列与频带行
    const px = e.clientX - rect.left - ML;
    const py = e.clientY - rect.top - MT;
    if (px < 0 || px > plotW || py < 0 || py > plotH) {
      setHover(null);
      return;
    }
    const frame = Math.floor((view.x + (px / plotW) * view.w) * frames);
    const band = bands - 1 - Math.floor((py / plotH) * bands);
    if (frame >= 0 && frame < frames && band >= 0 && band < bands) {
      setHover({ frame, band });
    } else {
      setHover(null);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const hoverInfo =
    hover && hover.frame < frames && hover.band < bands
      ? {
          ms: offsetsMs[hover.frame],
          bandLabel: `${fmtFreq(result.bandEdgesHz[hover.band])}–${fmtFreq(result.bandEdgesHz[hover.band + 1])} Hz`,
          diff: result.diffDb[hover.frame][hover.band],
        }
      : null;

  return (
    <div ref={containerRef}>
      <div className="heatmap">
        <canvas
          ref={canvasRef}
          style={{
            width: '100%',
            height: HEIGHT,
            display: 'block',
            cursor: view.w < 1 ? 'grab' : 'crosshair',
            touchAction: 'none',
            userSelect: 'none',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)}
          onDoubleClick={() => setView({ x: 0, w: 1 })}
        />
      </div>
      <p className="heatmap-readout">
        {hoverInfo
          ? `帧 +${hoverInfo.ms.toFixed(1)} ms · 频带 ${hoverInfo.bandLabel} · Δ ${
              hoverInfo.diff >= 0 ? '+' : ''
            }${hoverInfo.diff.toFixed(2)} dB`
          : '横轴：帧中心距接缝时间（ms，左缘为接缝）· 纵轴：对数频带（Hz）· 滚轮缩放 · 拖拽平移 · 双击复位'}
      </p>
    </div>
  );
}
