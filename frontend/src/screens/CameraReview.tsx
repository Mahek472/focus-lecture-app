import { useEffect, useMemo, useRef, useState } from "react";
import { CameraMonitor, STATE_WORD, type CameraReading } from "../camera/CameraMonitor";
import { Icon } from "../components/Status";
import { cssVar, fmtTime } from "../lib/format";
import { useCanvas, useThemeVersion } from "../lib/useCanvas";

// Play a recorded webcam clip while MediaPipe analyses it, to see what the camera branch reports
// for each feature at every moment. Clips come from recordings/<run>_cam/ via the dev server.

interface Clip { run: string; clip: string; url: string; mb: number }
interface Sample { t: number; face: boolean; turned: boolean; down: boolean; yaw: number | null; pitch: number | null }

const ROWS: { key: "face" | "turned" | "down"; label: string; bad: (s: Sample) => boolean }[] = [
  { key: "face", label: "Face not in view", bad: (s) => !s.face },
  { key: "turned", label: "Head turned", bad: (s) => s.turned },
  { key: "down", label: "Head down", bad: (s) => s.down },
];

export function CameraReview() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [sel, setSel] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const monitor = useMemo(() => new CameraMonitor(), []);
  const [r, setR] = useState<CameraReading>(monitor.last);
  const samples = useRef(new Map<number, Sample>());
  const blinks = useRef<number[]>([]);
  const [tick, setTick] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);

  useEffect(() => { fetch("/agent/clips").then((x) => x.json()).then((c: Clip[]) => { setClips(c); if (c[0]) setSel(c[0].url); }).catch(() => setClips([])); }, []);

  useEffect(() => {
    const v = video.current;
    if (!v || !sel) return;
    samples.current.clear(); blinks.current = []; setTick((x) => x + 1);
    let lastBlink: number | undefined;
    const off = monitor.onReading((x) => {
      if (!x.running) return;
      const t = v.currentTime;
      samples.current.set(Math.round(t * 10), { t, face: x.face, turned: x.headTurned, down: x.headDown, yaw: x.yawDeg, pitch: x.pitchDeg });
      const b = monitor.blinkTimes[monitor.blinkTimes.length - 1];
      if (b !== undefined && b !== lastBlink) { lastBlink = b; blinks.current.push(t); }
    });
    const ui = window.setInterval(() => { setR(monitor.last); setTick((x) => x + 1); }, 200);
    void monitor.attachVideo(v);
    return () => { off(); clearInterval(ui); monitor.detachVideo(); };
  }, [sel, monitor]);

  useEffect(() => { if (video.current) video.current.playbackRate = rate; }, [rate]);

  const all = [...samples.current.values()].sort((a, b) => a.t - b.t);
  const analysed = all.length / 10;   // ~10 samples per second of video
  const pct = (f: (s: Sample) => boolean) => (all.length ? Math.round((all.filter(f).length / all.length) * 100) : 0);
  const clip = clips.find((c) => c.url === sel);

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Camera review</h1><p>Play a recorded webcam clip and see what MediaPipe reports for each feature, moment by moment.</p></div>
        <label className="field"><span>Clip</span>
          <select value={sel} onChange={(e) => setSel(e.target.value)}>
            {clips.length === 0 && <option value="">No clips found in recordings/</option>}
            {clips.map((c) => <option key={c.url} value={c.url}>{c.run}: {c.clip} ({c.mb} MB)</option>)}
          </select>
        </label>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(280px, 1fr)", gap: 16, alignItems: "start" }} className="recap-grid">
        <section className="panel panel--primary">
          <video key={sel} ref={video} src={sel || undefined} controls playsInline muted
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              // browser-recorded WebM has no duration in its header: jump past the end once to learn it
              if (Number.isFinite(v.duration)) setDuration(v.duration);
              else { v.ondurationchange = () => { if (Number.isFinite(v.duration)) { setDuration(v.duration); v.ondurationchange = null; v.currentTime = 0; } }; v.currentTime = 1e9; }
            }}
            style={{ width: "100%", display: "block", background: "#0b0f13", transform: "scaleX(-1)" }} aria-label={`Webcam clip ${clip?.run ?? ""} ${clip?.clip ?? ""}`} />
          <div className="panel__body" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span className="small muted">Mirrored like a selfie view.</span>
            <label className="small">Speed <select value={rate} onChange={(e) => setRate(+e.target.value)}>
              <option value={1}>1x</option><option value={2}>2x</option><option value={4}>4x (may skip quick blinks)</option></select></label>
          </div>
        </section>

        <section className="panel" aria-live="polite">
          <div className="panel__head"><h2>MediaPipe now</h2><span className="spacer" /><span className="small muted num">{r.running ? `${r.fps} fps, ${r.delegate}` : "press play"}</span></div>
          <div className="panel__body" style={{ display: "grid", gap: 8 }}>
            {r.error && <div className="notice notice--warn"><Icon name="warn" />{r.error}</div>}
            <div className={`status status--${r.state === "watching" ? "good" : "warn"}`} style={{ fontSize: 16, fontWeight: 600 }}>
              <Icon name={r.state === "watching" ? "good" : "warn"} size={14} />{r.running ? STATE_WORD[r.state] : "Not analysing"}</div>
            {[["Face", !r.face, r.face ? "In view" : "Not in view"], ["Head turned", r.headTurned, r.headTurned ? "Yes" : "No"],
              ["Head down", r.headDown, r.headDown ? "Yes" : "No"], ["Eyes off screen", false, "Needs live gaze calibration"]].map(([k, bad, w]) => (
              <div key={k as string} style={{ display: "flex", gap: 8 }}><span className="muted" style={{ width: 120 }}>{k}</span>
                <span className={`status status--${bad ? "warn" : "good"}`}><Icon name={bad ? "warn" : "good"} />{w}</span></div>
            ))}
            <div style={{ display: "flex", gap: 8 }}><span className="muted" style={{ width: 120 }}>Head angles</span>
              <span className="num">{r.yawDeg == null ? "–" : `${r.yawDeg.toFixed(1)}° turn, ${(r.pitchDeg ?? 0).toFixed(1)}° tilt`}</span></div>
            <div style={{ display: "flex", gap: 8 }}><span className="muted" style={{ width: 120 }}>Blinks</span>
              <span className="num">{blinks.current.length} so far{analysed > 15 ? `, ${(blinks.current.length / analysed * 60).toFixed(1)} per minute` : ""}</span></div>
            <p className="small muted">Angles are relative to the first ~2 s of face in the clip. Flags: turn over 25°, down over 18°, held for 1 s. The live app adds the backend's 3 s rule on top.</p>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel__head"><h2>Feature timeline</h2><span className="spacer" />
          <span className="small muted">{analysed ? `${fmtTime(analysed)} analysed: face missing ${pct((s) => !s.face)}%, head turned ${pct((s) => s.turned)}%, head down ${pct((s) => s.down)}%` : "Play the clip to fill it in. Click to jump."}</span></div>
        <Timeline samples={all} blinks={blinks.current} duration={duration} now={video.current?.currentTime ?? 0} tick={tick}
          onSeek={(t) => { if (video.current) video.current.currentTime = t; }} />
      </section>
    </div>
  );
}

function Timeline({ samples, blinks, duration, now, tick, onSeek }: { samples: Sample[]; blinks: number[]; duration: number; now: number; tick: number; onSeek: (t: number) => void }) {
  const { ref, size } = useCanvas();
  const theme = useThemeVersion();
  const L = 130, rowH = 22, H = (ROWS.length + 2) * rowH + 70;
  useEffect(() => {
    const c = ref.current; if (!c || !size.w || !duration) return;
    const g = c.getContext("2d")!, dpr = c.width / size.w; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, size.w, size.h);
    const W = size.w - L - 12, X = (t: number) => L + (t / duration) * W;
    const col = { warn: cssVar("--signal"), ok: cssVar("--ok"), muted: cssVar("--text-muted"), grid: cssVar("--grid"), ink: cssVar("--ink"), accent: cssVar("--accent"), font: cssVar("--font") };
    g.font = `12px ${col.font}`; g.textBaseline = "middle";
    ROWS.forEach((row, i) => {
      const y = 8 + i * rowH;
      g.fillStyle = col.muted; g.fillText(row.label, 8, y + rowH / 2);
      g.fillStyle = col.grid; g.fillRect(L, y + 3, W, rowH - 6);
      for (const s of samples) { if (!row.bad(s)) continue; g.fillStyle = col.warn; g.fillRect(X(s.t) - 1, y + 3, Math.max(2, W / duration / 10), rowH - 6); }
    });
    const yb = 8 + ROWS.length * rowH;
    g.fillStyle = col.muted; g.fillText("Blinks", 8, yb + rowH / 2);
    g.fillStyle = col.ink; for (const b of blinks) g.fillRect(X(b) - 0.5, yb + 4, 1.5, rowH - 8);
    // head angles: turn (solid) and tilt (dashed), +/-30 degrees
    const ya = yb + rowH + 6, ah = 54, Y = (d: number) => ya + ah / 2 - (Math.max(-30, Math.min(30, d)) / 30) * (ah / 2);
    g.fillStyle = col.muted; g.fillText("Head angles", 8, ya + ah / 2);
    g.strokeStyle = col.grid; g.strokeRect(L, ya, W, ah);
    for (const [k, dash] of [["yaw", [] as number[]], ["pitch", [3, 3]]] as ["yaw" | "pitch", number[]][]) {
      g.setLineDash(dash); g.strokeStyle = col.ink; g.lineWidth = 1.2; g.beginPath();
      let started = false;
      for (const s of samples) { const v = s[k]; if (v == null) { started = false; continue; } const x = X(s.t), y = Y(v); if (started) g.lineTo(x, y); else { g.moveTo(x, y); started = true; } }
      g.stroke();
    }
    g.setLineDash([]);
    g.fillStyle = col.muted; g.textAlign = "right"; g.fillText("+30°", L - 4, ya + 6); g.fillText("−30°", L - 4, ya + ah - 6); g.textAlign = "left";
    g.textAlign = "right"; g.fillText("solid = turn, dashed = tilt (down +)", L + W, ya - 6); g.textAlign = "left";
    g.strokeStyle = col.accent; g.lineWidth = 1.5; g.beginPath(); g.moveTo(X(now), 4); g.lineTo(X(now), ya + ah); g.stroke();
    g.textAlign = "center"; g.fillStyle = col.muted;
    for (let t = 0; t <= duration; t += duration > 300 ? 60 : 30) g.fillText(fmtTime(t), X(t), H - 8);
    g.textAlign = "left";
  }, [size, theme, tick, duration, now, samples, blinks]);
  return <canvas ref={ref} role="img" aria-label="Camera features over the clip" style={{ width: "100%", height: H, display: "block", cursor: "pointer" }}
    onClick={(e) => { const rc = e.currentTarget.getBoundingClientRect(); const t = ((e.clientX - rc.left - L) / (rc.width - L - 12)) * duration; if (t >= 0 && t <= duration) onSeek(t); }} />;
}
