import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { Marker } from "../data/types";
import type { FocusPoint } from "../lib/uncertainty";
import { cssVar, fmtTime } from "../lib/format";
import { useCanvas, useThemeVersion } from "../lib/useCanvas";

export interface FocusTimelineHandle { toImage(title: string): HTMLCanvasElement }

interface Props {
  points: FocusPoint[];
  duration: number;
  range?: [number, number];
  lapses: { start: number; end: number }[];
  openLapseStart?: number | null;
  markers?: Marker[];
  thresholds: { start: number; end: number };
  showTruth?: boolean;
  playhead?: number;
  selection?: [number, number] | null;
  onSeek?: (t: number) => void;
  onBrush?: (r: [number, number] | null) => void;
  height?: number;
  compact?: boolean;
  ariaLabel: string;
  leftPad?: number;          // px left of the plot (axis labels); lets rows below align with the time axis
}

interface Opts extends Props { w: number; h: number; colors: Record<string, string>; title?: string }

function draw(ctx: CanvasRenderingContext2D, o: Opts) {
  const { w, h, colors: c } = o;
  const L = o.compact ? 4 : o.leftPad ?? 40, R = o.compact ? 4 : 12;
  const T = (o.title ? 30 : 0) + (o.markers?.length && !o.compact ? 18 : 6);
  const truthH = o.showTruth ? (o.compact ? 4 : 12) : 0;
  const B = (o.compact ? 2 : 20) + truthH;
  const pw = w - L - R, ph = h - T - B;
  const [a, b] = o.range ?? [0, Math.max(1, o.duration)];
  const X = (t: number) => L + ((t - a) / Math.max(1e-6, b - a)) * pw;
  const Y = (v: number) => T + (1 - v) * ph;
  ctx.clearRect(0, 0, w, h);
  ctx.font = `12px ${c.font}`; ctx.textBaseline = "middle";
  if (o.title) { // PNG export: opaque background + title
    ctx.fillStyle = c.raised; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = c.text; ctx.font = `600 15px ${c.font}`; ctx.textAlign = "left"; ctx.fillText(o.title, L, 15);
    ctx.font = `12px ${c.font}`;
  }

  ctx.save(); ctx.beginPath(); ctx.rect(L, T, pw, ph); ctx.clip();
  // lapse regions (the only warm colour)
  const lapses = [...o.lapses];
  if (o.openLapseStart != null) lapses.push({ start: o.openLapseStart, end: o.points.at(-1)?.t ?? o.openLapseStart });
  for (const l of lapses) {
    ctx.fillStyle = c.signalSoft; ctx.fillRect(X(l.start), T, Math.max(1, X(l.end) - X(l.start)), ph);
    ctx.fillStyle = c.signal; ctx.fillRect(X(l.start), T, Math.max(1, X(l.end) - X(l.start)), 3);
  }
  // selection
  if (o.selection) { ctx.fillStyle = c.accentSoft; ctx.fillRect(X(o.selection[0]), T, X(o.selection[1]) - X(o.selection[0]), ph); }
  // thresholds
  ctx.setLineDash([4, 4]); ctx.strokeStyle = c.muted; ctx.lineWidth = 1;
  for (const v of [o.thresholds.start, o.thresholds.end]) { ctx.beginPath(); ctx.moveTo(L, Y(v) + 0.5); ctx.lineTo(L + pw, Y(v) + 0.5); ctx.stroke(); }
  ctx.setLineDash([]);

  const pts = o.points.filter((p) => p.t >= a - 2 && p.t <= b + 2);
  // uncertainty band: solid fill where reliable, hatched where unreliable
  const hatch = ctx.createPattern(hatchTile(c.ink), "repeat");
  let i = 0;
  while (i < pts.length) {
    const un = pts[i].unreliable; let j = i;
    while (j + 1 < pts.length && pts[j + 1].unreliable === un) j++;
    const seg = pts.slice(Math.max(0, i - 1), j + 1);
    ctx.beginPath();
    seg.forEach((p, k) => (k ? ctx.lineTo(X(p.t), Y(p.hi)) : ctx.moveTo(X(p.t), Y(p.hi))));
    [...seg].reverse().forEach((p) => ctx.lineTo(X(p.t), Y(p.lo)));
    ctx.closePath();
    ctx.fillStyle = un && hatch ? hatch : c.inkSoft; ctx.fill();
    // the estimate itself: solid where reliable, dashed and faint where not
    ctx.beginPath();
    seg.forEach((p, k) => (k ? ctx.lineTo(X(p.t), Y(p.score)) : ctx.moveTo(X(p.t), Y(p.score))));
    ctx.strokeStyle = c.ink; ctx.globalAlpha = un ? 0.45 : 1; ctx.lineWidth = o.compact ? 1.2 : 1.8;
    ctx.setLineDash(un ? [3, 3] : []); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    i = j + 1;
  }
  // playhead
  if (o.playhead != null) { ctx.strokeStyle = c.accent; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(X(o.playhead), T); ctx.lineTo(X(o.playhead), T + ph); ctx.stroke(); }
  ctx.restore();

  // truth strip (replay)
  if (o.showTruth) {
    const y = T + ph + (o.compact ? 1 : 3);
    for (const p of pts) {
      if (!p.truth) continue;
      ctx.fillStyle = p.truth === "distracted" ? c.truthD : c.truthA;
      ctx.fillRect(X(p.t - 0.5), y, Math.max(1, X(p.t + 0.5) - X(p.t - 0.5)), truthH - (o.compact ? 1 : 3));
    }
  }
  if (o.compact) return;
  // markers
  if (o.markers?.length) {
    ctx.textAlign = "left";
    for (const m of o.markers) {
      if (m.t_video < a || m.t_video > b) continue;
      const x = X(m.t_video);
      ctx.fillStyle = c.text; ctx.beginPath(); ctx.moveTo(x - 4, T - 12); ctx.lineTo(x + 4, T - 12); ctx.lineTo(x, T - 5); ctx.fill();
      ctx.strokeStyle = c.rule; ctx.beginPath(); ctx.moveTo(x + 0.5, T); ctx.lineTo(x + 0.5, T + ph); ctx.stroke();
      ctx.fillStyle = c.muted; ctx.fillText(m.label, x + 6, T - 9);
    }
  }
  // axes
  ctx.fillStyle = c.muted; ctx.textAlign = "right";
  for (const [v, lab] of [[1, "1.0"], [o.thresholds.end, `${o.thresholds.end.toFixed(1)} end`], [o.thresholds.start, `${o.thresholds.start.toFixed(1)} start`], [0, "0"]] as const) {
    if (v === o.thresholds.end || v === o.thresholds.start) { ctx.textAlign = "left"; ctx.fillText(lab, L + 4, Y(v) - 7); ctx.textAlign = "right"; }
    else ctx.fillText(lab, L - 6, Y(v));
  }
  ctx.strokeStyle = c.rule; ctx.beginPath(); ctx.moveTo(L + 0.5, T); ctx.lineTo(L + 0.5, T + ph); ctx.lineTo(L + pw, T + ph + 0.5); ctx.stroke();
  const span = b - a, step = span > 1200 ? 300 : span > 600 ? 120 : span > 240 ? 60 : span > 90 ? 30 : span > 30 ? 10 : 5;
  ctx.textAlign = "center";
  for (let t = Math.ceil(a / step) * step; t <= b; t += step) ctx.fillText(fmtTime(t), X(t), h - 9);
}

function hatchTile(color: string) {
  const t = document.createElement("canvas"); t.width = 8; t.height = 8;
  const g = t.getContext("2d")!; g.strokeStyle = color; g.globalAlpha = 0.28; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, 8); g.lineTo(8, 0); g.stroke();
  return t;
}

function themeColors() {
  return { ink: cssVar("--ink"), inkSoft: cssVar("--ink-soft"), signal: cssVar("--signal"), signalSoft: cssVar("--signal-soft"),
    accent: cssVar("--accent"), accentSoft: cssVar("--accent-soft"), muted: cssVar("--text-muted"), text: cssVar("--text"),
    rule: cssVar("--rule"), raised: cssVar("--raised"), truthA: cssVar("--truth-attentive"), truthD: cssVar("--truth-distracted"),
    font: cssVar("--font") };
}

export const FocusTimeline = forwardRef<FocusTimelineHandle, Props>(function FocusTimeline(p, fref) {
  const { ref, size } = useCanvas();
  const theme = useThemeVersion();
  const drag = useRef<number | null>(null);
  const propsRef = useRef(p); propsRef.current = p;

  useImperativeHandle(fref, () => ({
    toImage(title: string) {
      const c = document.createElement("canvas"); c.width = 2400; c.height = 640;
      const ctx = c.getContext("2d")!; ctx.scale(2, 2);
      draw(ctx, { ...propsRef.current, compact: false, w: 1200, h: 320, colors: themeColors(), title, playhead: undefined });
      return c;
    },
  }));

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !size.w) return;
    const ctx = canvas.getContext("2d")!;
    const dpr = canvas.width / size.w;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, { ...p, w: size.w, h: size.h, colors: themeColors() });
  });  // redraw every render: data changes each second, drawing is cheap
  void theme;

  const tAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const L = p.compact ? 4 : p.leftPad ?? 40, R = p.compact ? 4 : 12;
    const [a, b] = p.range ?? [0, Math.max(1, p.duration)];
    return Math.min(b, Math.max(a, a + ((clientX - r.left - L) / (r.width - L - R)) * (b - a)));
  };

  return (
    <canvas ref={ref} role="img" aria-label={p.ariaLabel} tabIndex={p.onSeek || p.onBrush ? 0 : -1}
      style={{ width: "100%", height: p.height ?? 160, display: "block", cursor: p.onBrush ? "crosshair" : p.onSeek ? "pointer" : "default", touchAction: "none" }}
      onPointerDown={(e) => { if (!p.onBrush) return; drag.current = tAt(e.clientX); (e.target as Element).setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => { if (drag.current == null || !p.onBrush) return; const t = tAt(e.clientX); p.onBrush([Math.min(drag.current, t), Math.max(drag.current, t)]); }}
      onPointerUp={(e) => {
        if (drag.current != null && p.onBrush) { const t = tAt(e.clientX); if (Math.abs(t - drag.current) < 0.5) p.onBrush(null); drag.current = null; return; }
        p.onSeek?.(tAt(e.clientX));
      }}
      onKeyDown={(e) => {
        if (!p.onSeek || p.playhead == null) return;
        if (e.key === "ArrowRight") { e.preventDefault(); p.onSeek(p.playhead + 5); }
        if (e.key === "ArrowLeft") { e.preventDefault(); p.onSeek(Math.max(0, p.playhead - 5)); }
      }} />
  );
});
