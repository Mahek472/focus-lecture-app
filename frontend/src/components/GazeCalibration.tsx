import { useEffect, useState } from "react";
import { camera } from "../camera/CameraMonitor";

// Full-screen 5-point gaze calibration: centre, four corners, centre. For each dot the eyes get
// 0.7 s to settle, then 1.5 s of samples. About 13 s in total.
const TARGETS: [number, number][] = [[0, 0], [-0.9, -0.9], [0.9, -0.9], [0.9, 0.9], [-0.9, 0.9], [0, 0]];
const SETTLE_MS = 700, HOLD_MS = 1500;

export function GazeCalibration({ onDone }: { onDone: (result: { ok: boolean; reason?: string }) => void }) {
  const [i, setI] = useState(-1);   // -1 = intro

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { camera.pauseCollecting(); onDone({ ok: false, reason: "Calibration cancelled." }); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onDone]);

  useEffect(() => {
    if (i < 0) return;
    if (i >= TARGETS.length) {
      document.exitFullscreen?.().catch(() => {});
      onDone(camera.finishCalibration());
      return;
    }
    camera.pauseCollecting();
    const a = window.setTimeout(() => camera.beginTarget(...TARGETS[i]), SETTLE_MS);
    const b = window.setTimeout(() => setI((x) => x + 1), SETTLE_MS + HOLD_MS);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [i, onDone]);

  const start = () => { document.documentElement.requestFullscreen?.().catch(() => {}); setI(0); };
  const t = TARGETS[Math.min(Math.max(i, 0), TARGETS.length - 1)];

  return (
    <div role="dialog" aria-modal="true" aria-label="Gaze calibration"
      style={{ position: "fixed", inset: 0, zIndex: 100, background: "var(--bg)", color: "var(--text)" }}>
      {i < 0 ? (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeContent: "center", textAlign: "center", gap: 12, padding: 24 }}>
          <h2 style={{ fontSize: 22 }}>Gaze calibration</h2>
          <p>Sit as you will during the lecture. Keep your head still and follow the dot with your eyes.</p>
          <p className="muted small">Six dots, about 13 seconds. Press Escape to cancel.</p>
          <div><button className="btn btn--primary" onClick={start} autoFocus>Start</button></div>
        </div>
      ) : (
        <div aria-live="polite">
          <span className="sr-only">Dot {Math.min(i + 1, TARGETS.length)} of {TARGETS.length}</span>
          <div style={{ position: "absolute", left: `${50 + t[0] * 50}%`, top: `${50 + t[1] * 50}%`, transform: "translate(-50%, -50%)",
            width: 28, height: 28, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 0 6px var(--accent-soft)" }}>
            <div style={{ position: "absolute", left: "50%", top: "50%", width: 6, height: 6, marginLeft: -3, marginTop: -3, borderRadius: "50%", background: "#fff" }} />
          </div>
        </div>
      )}
    </div>
  );
}
