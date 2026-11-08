import { useEffect, useRef, useState } from "react";
import { CalibrationVideo, type CalibrationVideoHandle } from "../components/CalibrationVideo";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { CalibrationProgress } from "../data/types";
import { useConnection, useServerMessage, useSource } from "../state/source";
import { useSettings } from "../state/settings";
import { TraceViewer } from "../components/TraceViewer";
import { ConnectionStatus, Icon } from "../components/Status";
import { fmtTime } from "../lib/format";

// Matches scripts/headset_session.py record: 6 calibration + 4 held-out test blocks, alternating
// watch and count-back-by-7 (the BBBD distractor), so time-on-task drift can't pose as attention.
const PLAN = [...Array(10)].map((_, i) => ({ phase: i < 6 ? "Calibration" : "Held-out test", task: i % 2 ? "count" : "watch" }));

function verdict(auc: number) {
  if (auc >= 0.7) return { word: "Works for this person", text: "The model separates watching from counting well enough to use in the lecture.", ok: true };
  if (auc >= 0.6) return { word: "Borderline", text: "Check signal quality (contact, ear clip, 60 Hz hum) and repeat calibration before trusting it.", ok: false };
  return { word: "Not reliable for this person", text: "If the signal was clean, use a replay session for the demo instead.", ok: false };
}

export function Calibration() {
  const { runId = "" } = useParams();
  const nav = useNavigate();
  const { source } = useSource();
  const { settings } = useSettings();
  const conn = useConnection();
  const [p, setP] = useState<CalibrationProgress | null>(null);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");
  const clip = useRef<CalibrationVideoHandle>(null);

  useEffect(() => { source.connect(runId); return () => source.disconnect(); }, [source, runId]);
  useServerMessage("calibration", setP);

  const start = async () => {
    setError(""); setStarted(true); setP(null);
    clip.current?.play();
    try { await source.startCalibration(runId); } catch (e) { setError(e instanceof Error ? e.message : "Calibration could not start"); setStarted(false); }
  };

  const block = p ? p.block - 1 : -1;
  const cur = block >= 0 ? PLAN[block] : null;
  const done = !!p?.done;
  const totalS = (p?.block_s ?? settings.calibrationBlockS) * PLAN.length;
  const elapsed = p ? (p.block - 1) * p.block_s + (p.block_s - p.seconds_left) : 0;

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      <div className="page-head">
        <div>
          <h1>Calibration</h1>
          <p>About {Math.round(totalS / 60)} minutes. The participant watches a lecture clip throughout and follows the instruction for each block.</p>
        </div>
        <div className="toolbar">
          <ConnectionStatus state={conn} kind={source.kind} />
          <Link className="btn btn--quiet" to={`/setup/${runId}`}>Back to device setup</Link>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 280px) 1fr", gap: 16, alignItems: "start" }} className="cal-grid">
        <ol aria-label="Calibration blocks" style={{ listStyle: "none", margin: 0, padding: 0 }} className="panel">
          {PLAN.map((b, i) => {
            const state = done || i < block ? "done" : i === block ? "now" : "next";
            return (
              <li key={i} aria-current={state === "now" ? "step" : undefined}
                style={{ display: "grid", gridTemplateColumns: "28px 1fr auto", gap: 8, alignItems: "center", padding: "8px 12px",
                  borderBottom: "1px solid var(--rule)", borderLeft: `3px solid ${state === "now" ? "var(--accent)" : "transparent"}`,
                  background: state === "now" ? "var(--accent-soft)" : undefined,
                  borderTop: i === 6 ? "2px solid var(--rule-strong)" : undefined }}>
                <span className="num muted">{i + 1}</span>
                <span>{b.task === "watch" ? "Watch normally" : "Count back by 7"}<span className="small muted" style={{ display: "block" }}>{b.phase}</span></span>
                {state === "done" ? <span className="status status--good"><Icon name="good" /><span className="sr-only">Done</span></span> : null}
              </li>
            );
          })}
        </ol>

        <div style={{ display: "grid", gap: 16 }}>
          <section className="panel" aria-labelledby="cal-clip">
            <div className="panel__head"><h2 id="cal-clip">Calibration clip</h2><span className="spacer" />
              <span className="small muted">Any lecture except the session's own</span></div>
            <div style={{ padding: 12 }}>
              <CalibrationVideo ref={clip} overlay={cur && !done && p
                ? (cur.task === "watch" ? "Watch normally" : <>Count back by 7 from <span className="num">{p.start_number ?? "…"}</span></>)
                : undefined} />
            </div>
          </section>

          <section className="panel panel--primary" aria-live="polite">
            <div className="panel__body" style={{ padding: 24, minHeight: 220, display: "grid", gap: 14 }}>
              {!started && !done && (
                <>
                  <h2>Before you start</h2>
                  <ul style={{ margin: 0, paddingLeft: 18 }} className="muted">
                    <li>Load a lecture clip above (a video file from this computer or a YouTube link, not the session's lecture). It starts playing when you press Start and loops.</li>
                    <li>The participant sits still and keeps their eyes on the video in every block.</li>
                    <li>Read each instruction aloud when the block changes.</li>
                  </ul>
                  <div><button className="btn btn--primary" onClick={start} disabled={conn !== "open"}>Start calibration</button></div>
                  {error && <div className="notice notice--warn"><Icon name="warn" />{error}</div>}
                </>
              )}
              {started && !p && !done && <p className="muted">Waiting for the backend to start the first block</p>}
              {cur && !done && p && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <span className="small muted">Block {p.block} of {p.n_blocks}, {cur.phase.toLowerCase()}</span>
                    <span className="num" style={{ fontSize: 28, fontWeight: 600 }}>{fmtTime(p.seconds_left)}</span>
                  </div>
                  <div>
                    <p className="small muted">Say to the participant</p>
                    <p style={{ fontSize: 22, fontWeight: 500, lineHeight: 1.35 }}>
                      {cur.task === "watch"
                        ? "Watch the lecture normally, as you would at home."
                        : <>Keep your eyes on the video, and silently count back by 7 from <span className="num" style={{ fontWeight: 700 }}>{p.start_number ?? "a number I give you"}</span>. Don't say the numbers aloud.</>}
                    </p>
                  </div>
                  <div aria-hidden style={{ height: 6, background: "var(--grid)", borderRadius: 3 }}>
                    <div style={{ width: `${(1 - p.seconds_left / p.block_s) * 100}%`, height: "100%", background: "var(--accent)", borderRadius: 3 }} />
                  </div>
                  <p className="small muted num">{fmtTime(elapsed)} of {fmtTime(totalS)} elapsed</p>
                </>
              )}
              {done && p?.auc != null && (() => {
                const v = verdict(p.auc);
                return (
                  <>
                    <h2>Calibration result</h2>
                    <p><span className="num" style={{ fontSize: 28, fontWeight: 600 }}>AUC {p.auc.toFixed(2)}</span>
                      <span className={`status status--${v.ok ? "good" : "warn"}`} style={{ marginLeft: 12 }}><Icon name={v.ok ? "good" : "warn"} />{v.word}</span></p>
                    <p>{v.text}</p>
                    <p className="small muted">AUC measures how well the held-out blocks are separated: 0.5 is chance, 1.0 is perfect. On the public BBBD dataset, calibrated people averaged 0.87 with these 8 channels.</p>
                    <div className="toolbar">
                      <button className="btn btn--primary" onClick={() => nav(`/watch/${runId}`)} disabled={p.auc < 0.6}>Start the lecture</button>
                      <button className="btn" onClick={start}>Repeat calibration</button>
                      {p.auc < 0.6 && <Link className="btn btn--quiet" to="/sessions">Use a replay session instead</Link>}
                    </div>
                  </>
                );
              })()}
            </div>
          </section>

          <section className="panel" aria-labelledby="cal-sig">
            <div className="panel__head"><h2 id="cal-sig">Signal during calibration</h2><span className="spacer" />
              <span className="small muted">Watch for flat or very noisy channels</span></div>
            <div style={{ height: 220, padding: 8 }}>
              <TraceViewer live channels={settings.montage} gain={50} windowS={8} notch={settings.notch} ariaLabel="Live EEG during calibration" />
            </div>
          </section>
        </div>
      </div>
      <style>{`@media (max-width: 860px) { .cal-grid { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}
