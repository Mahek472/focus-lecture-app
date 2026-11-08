import { useEffect, useMemo, useRef } from "react";
import { useSource } from "../state/source";
import { DisplayFilter, std } from "../lib/dsp";
import { cssVar } from "../lib/format";
import { prefersReducedMotion, useCanvas, useThemeVersion } from "../lib/useCanvas";

export type ArtifactKind = "blink" | "movement" | "lost_contact";

interface StaticData { sfreq: number; samples: ArrayLike<number>[]; t0?: number } // t0 = time of sample 0 (s)

interface Props {
  channels: string[];
  /** live: draw the source's EEG stream. Otherwise draw `data` over `range`. */
  live?: boolean;
  data?: StaticData;
  range?: [number, number];
  gain: number;              // uV per division (one channel row)
  windowS: number;           // live window length
  notch: 50 | 60;
  filter?: boolean;          // apply the display filter to static data (live data is always filtered)
  highlight?: string;
  onArtifacts?: (a: Set<ArtifactKind>) => void;
  ariaLabel: string;
  height?: number | string;
}

const LABEL_W = 44, AXIS_H = 20, BUF_S = 30;

export function TraceViewer(p: Props) {
  const { source } = useSource();
  const { ref, size } = useCanvas();
  const theme = useThemeVersion();
  const live = useRef({ buf: [] as Float32Array[], filt: [] as DisplayFilter[], pos: 0, total: 0, sfreq: 125, map: [] as number[] });
  const artRef = useRef<string>("");
  const propsRef = useRef(p);
  propsRef.current = p;

  // ---------------------------------------------------------------- live buffer
  useEffect(() => {
    if (!p.live) return;
    const L = live.current;
    L.buf = []; L.total = 0; L.pos = 0;
    return source.on("eeg", (m) => {
      const chans = propsRef.current.channels;
      if (!L.buf.length || L.sfreq !== m.sfreq) {
        L.sfreq = m.sfreq;
        L.buf = chans.map(() => new Float32Array(BUF_S * m.sfreq));
        L.filt = chans.map(() => new DisplayFilter(m.sfreq, propsRef.current.notch));
        L.pos = 0; L.total = 0;
      }
      L.map = chans.map((c) => m.channels.indexOf(c));
      const n = m.samples[0]?.length ?? 0, len = L.buf[0].length;
      for (let c = 0; c < chans.length; c++) {
        const src = m.samples[L.map[c]];
        for (let k = 0; k < n; k++) L.buf[c][(L.pos + k) % len] = src ? L.filt[c].step(src[k]) : 0;
      }
      L.pos = (L.pos + n) % len; L.total += n;
    });
  }, [p.live, source, p.notch, p.channels.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- static data (filtered once)
  const staticData = useMemo(() => {
    if (!p.data) return null;
    if (!p.filter) return p.data;
    const out = p.data.samples.map((x) => {
      const f = new DisplayFilter(p.data!.sfreq, p.notch), y = new Float32Array(x.length);
      for (let i = 0; i < x.length; i++) y[i] = f.step(x[i]);
      return y;
    });
    return { ...p.data, samples: out };
  }, [p.data, p.filter, p.notch]);

  // ---------------------------------------------------------------- draw
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !size.w) return;
    const ctx = canvas.getContext("2d")!;
    const colors = { ink: cssVar("--ink"), grid: cssVar("--grid"), rule: cssVar("--rule"), muted: cssVar("--text-muted"),
      accent: cssVar("--accent"), signal: cssVar("--signal"), font: cssVar("--font") };
    let raf = 0, last = 0;
    const reduced = prefersReducedMotion();

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (reduced && now - last < 250) return;   // reduced motion: redraw 4x/s instead of 60
      last = now;
      draw();
    };

    const draw = () => {
      const q = propsRef.current;
      const dpr = canvas.width / size.w;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);
      const n = q.channels.length, plotW = size.w - LABEL_W, plotH = size.h - AXIS_H, rowH = plotH / n;

      let series: (c: number, i: number) => number, count: number, sfreq: number, tStart: number;
      if (q.live) {
        const L = live.current;
        sfreq = L.sfreq; count = Math.min(L.total, Math.round(q.windowS * sfreq));
        const len = L.buf[0]?.length ?? 1, start = L.pos - count;
        series = (c, i) => L.buf[c]?.[((start + i) % len + len) % len] ?? 0;
        tStart = (L.total - count) / sfreq;
        reportArtifacts(L, sfreq);
      } else if (staticData) {
        sfreq = staticData.sfreq;
        const t0 = staticData.t0 ?? 0, total = staticData.samples[0]?.length ?? 0;
        const [a, b] = q.range ?? [t0, t0 + total / sfreq];
        const i0 = Math.max(0, Math.floor((a - t0) * sfreq)), i1 = Math.min(total, Math.ceil((b - t0) * sfreq));
        count = Math.max(0, i1 - i0); tStart = t0 + i0 / sfreq;
        series = (c, i) => staticData.samples[c]?.[i0 + i] ?? 0;
      } else return;

      const spanS = q.live ? q.windowS : count / sfreq;
      // grid: one line per second (labels every 1, 2 or 5 s depending on span)
      ctx.font = `12px ${colors.font}`; ctx.textBaseline = "middle";
      const step = spanS > 40 ? 10 : spanS > 16 ? 2 : 1;
      ctx.strokeStyle = colors.grid; ctx.lineWidth = 1;
      const firstTick = Math.ceil(tStart / step) * step;
      for (let t = firstTick; t <= tStart + spanS; t += step) {
        const x = LABEL_W + ((t - tStart) / spanS) * plotW;
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, plotH); ctx.stroke();
        ctx.fillStyle = colors.muted; ctx.textAlign = "center";
        const m = Math.floor(t / 60), s = Math.round(t % 60);
        ctx.fillText(`${m}:${String(s).padStart(2, "0")}`, x, plotH + AXIS_H / 2 + 1);
      }
      ctx.strokeStyle = colors.rule;
      ctx.beginPath(); ctx.moveTo(LABEL_W + 0.5, 0); ctx.lineTo(LABEL_W + 0.5, plotH); ctx.lineTo(size.w, plotH + 0.5); ctx.stroke();

      const pxPerUv = rowH / q.gain;
      for (let c = 0; c < n; c++) {
        const y0 = rowH * (c + 0.5);
        // clip each channel to about its own row, as clinical viewers do, so one bad channel can't cover the rest
        ctx.save(); ctx.beginPath(); ctx.rect(LABEL_W, y0 - rowH * 0.75, plotW, rowH * 1.5); ctx.clip();
        const hl = q.highlight === q.channels[c];
        ctx.strokeStyle = hl ? colors.accent : colors.ink; ctx.lineWidth = hl ? 1.6 : 1.1;
        ctx.beginPath();
        if (count <= plotW * 2) {
          for (let i = 0; i < count; i++) {
            const x = LABEL_W + (i / Math.max(1, (q.live ? q.windowS * sfreq : count) - 1)) * plotW, y = y0 - series(c, i) * pxPerUv;
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          }
        } else {             // min/max per pixel column
          const per = count / plotW;
          for (let px = 0; px < plotW; px++) {
            const a = Math.floor(px * per), b = Math.min(count, Math.floor((px + 1) * per));
            let lo = Infinity, hi = -Infinity;
            for (let i = a; i < b; i++) { const v = series(c, i); if (v < lo) lo = v; if (v > hi) hi = v; }
            const x = LABEL_W + px + 0.5;
            if (px === 0) ctx.moveTo(x, y0 - hi * pxPerUv);
            ctx.lineTo(x, y0 - hi * pxPerUv); ctx.lineTo(x, y0 - lo * pxPerUv);
          }
        }
        ctx.stroke();
        ctx.restore();
      }
      // channel labels
      ctx.textAlign = "left";
      for (let c = 0; c < n; c++) {
        ctx.fillStyle = q.highlight === q.channels[c] ? colors.accent : colors.muted;
        ctx.fillText(q.channels[c], 8, rowH * (c + 0.5));
      }
    };

    const reportArtifacts = (L: typeof live.current, sfreq: number) => {
      const q = propsRef.current;
      if (!q.onArtifacts || L.total < sfreq * 2) return;
      const len = L.buf[0].length, take = (c: number, s: number) => {
        const out = new Float32Array(Math.round(s * sfreq));
        for (let i = 0; i < out.length; i++) out[i] = L.buf[c][((L.pos - out.length + i) % len + len) % len];
        return out;
      };
      const found = new Set<ArtifactKind>();
      const fp1 = q.channels.indexOf("Fp1");
      if (fp1 >= 0) { const x = take(fp1, 0.6); if (Math.max(...x) - Math.min(...x) > 100) found.add("blink"); }
      let big = 0;
      for (let c = 0; c < q.channels.length; c++) {
        const x = take(c, 1); if (Math.max(...x) - Math.min(...x) > 150) big++;
        if (std(take(c, 2)) < 0.5) found.add("lost_contact");
      }
      if (big >= 5) found.add("movement");
      const key = [...found].sort().join(",");
      if (key !== artRef.current) { artRef.current = key; q.onArtifacts(found); }
    };

    if (p.live) raf = requestAnimationFrame(frame); else draw();
    return () => cancelAnimationFrame(raf);
  }, [size, theme, staticData, p.live, p.gain, p.windowS, p.range?.[0], p.range?.[1], p.highlight, p.channels.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  return <canvas ref={ref} role="img" aria-label={p.ariaLabel}
    style={{ width: "100%", height: p.height ?? "100%", display: "block" }} />;
}
