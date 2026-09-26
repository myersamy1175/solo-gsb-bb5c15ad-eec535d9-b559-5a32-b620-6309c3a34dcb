import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtTick } from '../utils/format';

export interface Region {
  /** 秒 */
  start: number;
  /** 秒 */
  end: number;
}

export interface SeamMarker {
  /** 秒 */
  start: number;
  /** 秒 */
  end: number;
  /** 候选编号（与候选列表对应，如 "1"） */
  label: string;
  /** 当前选中项（导出目标），高亮显示 */
  selected: boolean;
}

interface WaveformProps {
  buffer: AudioBuffer | null;
  /** 用户粗选区间（橙色边界，可拖动） */
  selection: Region | null;
  /** 候选接缝标记（按代价排序编号） */
  markers: SeamMarker[];
  onSelectionChange: (region: Region) => void;
}

const HEIGHT = 260;
const HANDLE_HIT_PX = 8;
const MIN_REGION_SEC = 0.02;

/** 绘制候选编号徽标（带底色的小色块），横向自动夹取在画布内 */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  selected: boolean,
  align: 'left' | 'right',
  canvasWidth: number,
): void {
  ctx.font = 'bold 11px system-ui, sans-serif';
  const w = Math.max(16, Math.ceil(ctx.measureText(label).width) + 10);
  const h = 14;
  let bx = align === 'left' ? x + 3 : x - 3 - w;
  bx = Math.max(1, Math.min(bx, canvasWidth - w - 1));
  ctx.fillStyle = selected ? '#2fd27d' : 'rgba(47,210,125,0.35)';
  ctx.fillRect(bx, y, w, h);
  ctx.fillStyle = selected ? '#06251a' : '#d8e6de';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, bx + w / 2, y + h / 2 + 0.5);
}

interface Peaks {
  mins: Float32Array;
  maxs: Float32Array;
}

function computePeaks(buffer: AudioBuffer, columns: number): Peaks {
  const len = buffer.length;
  const nCh = buffer.numberOfChannels;
  const mins = new Float32Array(columns).fill(Infinity);
  const maxs = new Float32Array(columns).fill(-Infinity);
  const perCol = len / columns;
  for (let c = 0; c < nCh; c++) {
    const d = buffer.getChannelData(c);
    for (let col = 0; col < columns; col++) {
      const from = Math.floor(col * perCol);
      const to = Math.min(len, Math.max(from + 1, Math.floor((col + 1) * perCol)));
      const stride = Math.max(1, Math.floor((to - from) / 64));
      let mn = mins[col];
      let mx = maxs[col];
      for (let i = from; i < to; i += stride) {
        const v = d[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      mins[col] = mn;
      maxs[col] = mx;
    }
  }
  return { mins, maxs };
}

export function Waveform({ buffer, selection, markers, onSelectionChange }: WaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const dragRef = useRef<{ mode: 'new' | 'start' | 'end'; anchor: number } | null>(null);
  const duration = buffer?.duration ?? 0;

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

  const peaks = useMemo(() => {
    if (!buffer || width <= 0) return null;
    return computePeaks(buffer, width);
  }, [buffer, width]);

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

    if (!buffer || !peaks || duration === 0) {
      ctx.fillStyle = 'rgba(230,235,245,0.45)';
      ctx.font = '14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('导入音频文件后，在波形上拖拽框选大致循环区间', width / 2, HEIGHT / 2);
      return;
    }

    const mid = HEIGHT / 2;
    const amp = mid - 14;

    // 时间轴刻度
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((s) => s >= duration / 8) ?? 600;
    ctx.fillStyle = 'rgba(230,235,245,0.35)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (let t = 0; t <= duration + 1e-9; t += step) {
      const x = Math.round((t / duration) * width) + 0.5;
      ctx.fillRect(x, HEIGHT - 16, 1, 5);
      ctx.fillText(fmtTick(t), x, HEIGHT - 4);
    }

    // 中心线
    ctx.fillStyle = 'rgba(230,235,245,0.12)';
    ctx.fillRect(0, mid, width, 1);

    // 波形
    ctx.fillStyle = '#5b8def';
    for (let x = 0; x < width; x++) {
      const mn = peaks.mins[x];
      const mx = peaks.maxs[x];
      if (!Number.isFinite(mn) || !Number.isFinite(mx)) continue;
      const y1 = mid - mx * amp;
      const y2 = mid - mn * amp;
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }

    // 用户选区
    if (selection) {
      const x1 = (selection.start / duration) * width;
      const x2 = (selection.end / duration) * width;
      ctx.fillStyle = 'rgba(91,141,239,0.16)';
      ctx.fillRect(x1, 0, x2 - x1, HEIGHT);
      ctx.fillStyle = '#ffb020';
      ctx.fillRect(x1 - 1.5, 0, 3, HEIGHT);
      ctx.fillRect(x2 - 1.5, 0, 3, HEIGHT);
      // 把手帽
      ctx.fillRect(x1 - 4, 0, 8, 6);
      ctx.fillRect(x2 - 4, 0, 8, 6);
    }

    // 候选接缝标记：未选中的先画，选中的最后画（置于上层）
    if (markers.length > 0) {
      const drawMarker = (m: SeamMarker, idx: number) => {
        const x1 = (m.start / duration) * width;
        const x2 = (m.end / duration) * width;
        if (m.selected) {
          ctx.fillStyle = 'rgba(47,210,125,0.10)';
          ctx.fillRect(x1, 0, x2 - x1, HEIGHT);
        }
        ctx.fillStyle = m.selected ? '#2fd27d' : 'rgba(47,210,125,0.4)';
        ctx.fillRect(x1 - 1, 0, 2, HEIGHT);
        ctx.fillRect(x2 - 1, 0, 2, HEIGHT);
        // 编号徽标：起点侧顶部、终点侧底部，按候选序号纵向错位避免互相遮挡
        drawBadge(ctx, x1, 6 + idx * 16, m.label, m.selected, 'left', width);
        drawBadge(ctx, x2, HEIGHT - 40 - idx * 16, m.label, m.selected, 'right', width);
      };
      markers.forEach((m, idx) => {
        if (!m.selected) drawMarker(m, idx);
      });
      markers.forEach((m, idx) => {
        if (m.selected) drawMarker(m, idx);
      });
    }
  }, [peaks, selection, markers, width, buffer, duration]);

  const xToTime = useCallback(
    (clientX: number): number => {
      const canvas = canvasRef.current;
      if (!canvas || duration === 0) return 0;
      const rect = canvas.getBoundingClientRect();
      const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
      return (x / rect.width) * duration;
    },
    [duration],
  );

  const hitHandle = useCallback(
    (clientX: number): 'start' | 'end' | null => {
      const canvas = canvasRef.current;
      if (!canvas || !selection || duration === 0) return null;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const x1 = (selection.start / duration) * rect.width;
      const x2 = (selection.end / duration) * rect.width;
      if (Math.abs(x - x1) <= HANDLE_HIT_PX) return 'start';
      if (Math.abs(x - x2) <= HANDLE_HIT_PX) return 'end';
      return null;
    },
    [selection, duration],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!buffer) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const handle = hitHandle(e.clientX);
    if (handle) {
      dragRef.current = { mode: handle, anchor: 0 };
      return;
    }
    const t = xToTime(e.clientX);
    dragRef.current = { mode: 'new', anchor: t };
    onSelectionChange({ start: t, end: t });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const drag = dragRef.current;
    if (!drag) {
      // 悬停反馈：靠近把手时显示横向调整光标
      if (canvas && buffer) {
        canvas.style.cursor = hitHandle(e.clientX) ? 'ew-resize' : 'crosshair';
      }
      return;
    }
    if (!buffer || !selection) return;
    const t = xToTime(e.clientX);
    if (drag.mode === 'new') {
      onSelectionChange({ start: Math.min(drag.anchor, t), end: Math.max(drag.anchor, t) });
    } else if (drag.mode === 'start') {
      onSelectionChange({
        start: Math.min(t, selection.end - MIN_REGION_SEC),
        end: selection.end,
      });
    } else {
      onSelectionChange({
        start: selection.start,
        end: Math.max(t, selection.start + MIN_REGION_SEC),
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div ref={containerRef} className="waveform">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: HEIGHT, display: 'block', cursor: buffer ? 'crosshair' : 'default' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </div>
  );
}
