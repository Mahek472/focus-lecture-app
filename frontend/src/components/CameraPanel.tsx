import { useCallback, useEffect, useRef, useState } from "react";
import { camera, STATE_WORD } from "../camera/CameraMonitor";
import { useCameraReading } from "../camera/useCamera";
import { GazeCalibration } from "./GazeCalibration";
import { Icon } from "./Status";

// Camera check: start the webcam, see each attention flag live, and calibrate gaze.
// Used in Device setup (full) and on the Watch screen (compact).

export function CameraPanel({ compact = false }: { compact?: boolean }) {
  const r = useCameraReading();
  const preview = useRef<HTMLVideoElement>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [calMsg, setCalMsg] = useState("");
  const [showPreview, setShowPreview] = useState(!compact);

  useEffect(() => {
    if (preview.current) preview.current.srcObject = r.running && showPreview ? camera.previewStream : null;
  }, [r.running, showPreview]);

  const done = useCallback((res: { ok: boolean; reason?: string }) => {
    setCalibrating(false);
    setCalMsg(res.ok ? "Gaze calibrated for this person and screen." : res.reason ?? "Calibration failed.");
  }, []);

  const flags: [string, boolean, string][] = [
    ["Face", !r.face, r.face ? "In view" : "Not in view"],
    ["Head", r.headTurned || r.headDown, r.headTurned ? "Turned away" : r.headDown ? "Down" : "Facing the screen"],
    ["Eyes", r.eyesOff, !r.calibrated ? "Calibrate gaze to check" : r.eyesOff ? "Off screen" : "On screen"],
  ];

  return (
    <div style={{ display: "grid", gap: compact ? 6 : 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {!r.running
          ? <button className={`btn ${compact ? "btn--small" : "btn--primary"}`} onClick={() => void camera.start()}>Start camera</button>
          : <button className={`btn ${compact ? "btn--small" : ""}`} onClick={() => camera.stop()}>Stop camera</button>}
        {r.running && <button className={`btn ${compact ? "btn--small" : ""}`} onClick={() => { setCalMsg(""); setCalibrating(true); }}>
          {r.calibrated ? "Recalibrate gaze" : "Calibrate gaze"}</button>}
        {compact && r.running && <label className="small" style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={showPreview} onChange={(e) => setShowPreview(e.target.checked)} />Preview</label>}
        {r.running && <span className="small muted num">{r.fps} fps, {r.delegate === "GPU" ? "GPU" : "CPU"}</span>}
      </div>
      {r.error && <div className="notice notice--warn"><Icon name="warn" />{r.error}</div>}
      {calMsg && <p className="small" style={{ color: calMsg.startsWith("Gaze calibrated") ? "var(--ok)" : "var(--signal)" }}>{calMsg}</p>}

      {r.running && (
        <div style={{ display: "grid", gridTemplateColumns: showPreview ? (compact ? "96px 1fr" : "minmax(160px, 240px) 1fr") : "1fr", gap: 10, alignItems: "start" }}>
          {showPreview && <video ref={preview} muted playsInline autoPlay aria-label="Webcam preview"
            style={{ width: "100%", borderRadius: 4, transform: "scaleX(-1)", background: "#0b0f13" }} />}
          <div style={{ display: "grid", gap: 4 }}>
            <div className={`status status--${r.state === "watching" ? "good" : "warn"}`} style={{ fontWeight: 600 }}>
              <Icon name={r.state === "watching" ? "good" : "warn"} />{STATE_WORD[r.state]}
            </div>
            {flags.map(([k, bad, word]) => (
              <div key={k} className="small" style={{ display: "flex", gap: 6 }}>
                <span className="muted" style={{ width: 40 }}>{k}</span>
                <span className={`status status--${bad ? "warn" : "good"}`}><Icon name={bad ? "warn" : "good"} />{word}</span>
              </div>
            ))}
            <div className="small" style={{ display: "flex", gap: 6 }}>
              <span className="muted" style={{ width: 40 }}>Blinks</span>
              <span className="num">{r.blinkRate == null ? "measuring (15 s)" : `${Math.round(r.blinkRate)} per minute`}</span>
            </div>
            {!compact && (
              <p className="small muted num">Head {r.yawDeg == null ? "–" : `${r.yawDeg.toFixed(1)}° turn, ${(r.pitchDeg ?? 0).toFixed(1)}° tilt (from the on-screen pose; flags at 25° turn, 18° down)`}
                {r.gaze ? `, gaze ${r.gaze.x.toFixed(2)}, ${r.gaze.y.toFixed(2)}` : ""}</p>
            )}
            {!compact && r.calibrated && r.gaze && (
              <div aria-hidden style={{ position: "relative", width: 160, height: 100, border: "1px solid var(--rule-strong)", borderRadius: 3, marginTop: 4 }}>
                <div style={{ position: "absolute", inset: "-15%", border: "1px dashed var(--rule)", borderRadius: 3 }} />
                <div style={{ position: "absolute", width: 8, height: 8, borderRadius: "50%", background: r.eyesOff ? "var(--signal)" : "var(--accent)",
                  left: `${Math.min(115, Math.max(-15, 50 + r.gaze.x * 50))}%`, top: `${Math.min(115, Math.max(-15, 50 + r.gaze.y * 50))}%`, transform: "translate(-50%, -50%)" }} />
              </div>
            )}
          </div>
        </div>
      )}
      {!compact && <p className="small muted">The webcam is analysed in this browser only; video is not sent anywhere. Blink rate is shown for information and never flags a lapse on its own.</p>}
      {calibrating && <GazeCalibration onDone={done} />}
    </div>
  );
}
