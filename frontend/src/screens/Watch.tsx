import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { BandPowerUpdate, FocusUpdate, InterventionEvent, InterventionResponse, Lapse, Marker, StatusUpdate } from "../data/types";
import { useConnection, useServerMessage, useSource } from "../state/source";
import { useSettings } from "../state/settings";
import { useRun } from "../state/useRun";
import { VideoPlayer, type VideoHandle } from "../components/VideoPlayer";
import { TraceViewer, type ArtifactKind } from "../components/TraceViewer";
import { FocusTimeline } from "../components/FocusTimeline";
import { BandPowerPanel, engagement, meanBands } from "../components/BandPowerPanel";
import { InterventionOverlay } from "../components/InterventionOverlay";
import { HeadMap } from "../components/HeadMap";
import { ConnectionStatus, FocusStatus, Icon } from "../components/Status";
import { toPoints, UNCERTAINTY_SOURCE } from "../lib/uncertainty";
import { forceSimVideo } from "../lib/flags";
import { fmtTime } from "../lib/format";
import { CameraPanel } from "../components/CameraPanel";
import { camera } from "../camera/CameraMonitor";
import { useCameraReading } from "../camera/useCamera";

const MARKER_PRESETS = ["Slide change", "Question asked", "Looked at phone", "Noise in room"];
const GAINS = [10, 20, 50, 100, 200];
const WINDOWS = [5, 10, 20];

export function Watch() {
  const { runId = "" } = useParams();
  const nav = useNavigate();
  const info = useRun(runId);
  const { source, recorder } = useSource();
  const { settings } = useSettings();
  const conn = useConnection();
  const video = useRef<VideoHandle>(null);
  const [focus, setFocus] = useState<FocusUpdate[]>([]);
  const [bands, setBands] = useState<BandPowerUpdate | null>(null);
  const [engHist, setEngHist] = useState<number[]>([]);
  const [lapses, setLapses] = useState<Lapse[]>([]);
  const [openLapse, setOpenLapse] = useState<number | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [status, setStatus] = useState<StatusUpdate | null>(null);
  const [intervention, setIntervention] = useState<InterventionEvent | null>(null);
  const [artifacts, setArtifacts] = useState<Set<ArtifactKind>>(new Set());
  const [gain, setGain] = useState(50);
  const [windowS, setWindowS] = useState(10);
  const [captions, setCaptions] = useState(settings.captions);
  const [t, setT] = useState(0);
  const [ended, setEnded] = useState(false);
  const [markerOpen, setMarkerOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const lastSent = useRef({ t: -1, playing: false, at: 0 });

  const ready = info && info !== "missing";
  const transcript = ready ? info.transcript : [];

  // connect + record
  useEffect(() => {
    if (!ready) return;
    source.connect(runId);
    recorder.attach(source, runId, transcript);
    return () => { recorder.detach(); source.disconnect(); };
  }, [ready, runId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (conn === "open") source.send({ type: "settings", intervention: settings.intervention, sensitivity: settings.sensitivity });
  }, [conn]); // eslint-disable-line react-hooks/exhaustive-deps

  // one entry per second of video: a rewind re-watches those seconds and replaces them
  useServerMessage("focus", (m) => setFocus((f) => {
    const sec = Math.round(m.t_video);
    if (!f.length || sec > Math.round(f[f.length - 1].t_video)) return [...f, m];
    const rest = f.filter((x) => Math.round(x.t_video) !== sec);
    const i = rest.findIndex((x) => x.t_video > m.t_video);
    return i < 0 ? [...rest, m] : [...rest.slice(0, i), m, ...rest.slice(i)];
  }));
  useServerMessage("bands", (m) => { setBands(m); const mb = meanBands(m); if (mb) setEngHist((h) => [...h.slice(-299), engagement(mb)]); });
  const openRef = useRef<number | null>(null);
  useServerMessage("lapse_start", (m) => { openRef.current = m.t_video; setOpenLapse(m.t_video); });
  useServerMessage("lapse_end", (m) => {
    const start = openRef.current;
    if (start != null) setLapses((l) => [...l, { start, end: m.t_video, snippet: "" }]);
    openRef.current = null; setOpenLapse(null);
  });
  useServerMessage("status", setStatus);
  useServerMessage("intervention", (m) => {
    if (settings.intervention === "recap") return;
    if (m.action === "pause") video.current?.pause();
    setIntervention(m);
  });

  const onVideoState = useCallback((now: number, playing: boolean) => {
    setT(now);
    recorder.setVideoTime(now);
    const L = lastSent.current, ms = performance.now();
    // contract: every second while playing, and on play / pause / seek
    if (playing !== L.playing || Math.abs(now - L.t - (ms - L.at) / 1000 * (L.playing ? 1 : 0)) > 1.5 || ms - L.at >= 1000) {
      source.send({ type: "video_state", t_video: +now.toFixed(2), playing });
      lastSent.current = { t: now, playing, at: ms };
    }
  }, [source, recorder]);

  // webcam attention state -> backend once a second (it applies the 3 s camera override)
  const cam = useCameraReading(2);
  const tRef = useRef(0); tRef.current = t;
  useEffect(() => {
    if (!cam.running) return;
    const id = window.setInterval(() => {
      const r = camera.last;
      if (!r.running) return;
      source.send({ type: "camera", t_video: +tRef.current.toFixed(2), state: r.state, face: r.face, head_turned: r.headTurned,
        head_down: r.headDown, eyes_off: r.eyesOff, blink_rate: r.blinkRate == null ? null : Math.round(r.blinkRate) });
    }, 1000);
    return () => clearInterval(id);
  }, [cam.running, source]);

  const respond = useCallback((choice: InterventionResponse["choice"]) => {
    setIntervention((ev) => {
      if (!ev) return null;
      source.send({ type: "intervention_response", choice, t_video: ev.t_video });
      if (choice === "focused") source.send({ type: "feedback", kind: "false_alarm", t_video: ev.t_video });
      if (choice === "rewind") video.current?.seek(ev.rewind_to);
      video.current?.play();
      return null;
    });
  }, [source]);

  const addMarker = (label: string) => {
    const m = recorder.addMarker(runId, label, t);
    if (m) setMarkers((x) => [...x, m]);
    setMarkerOpen(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      if (e.key === "m" || e.key === "M") { e.preventDefault(); setMarkerOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const stop = async () => {
    setStopping(true);
    video.current?.pause();
    try { await source.stopRun(runId); } finally { nav(`/recap/${runId}`); }
  };

  const points = useMemo(() => toPoints(focus), [focus]);
  const latest = points.at(-1);
  const latestRaw = focus.at(-1);
  const quality = latestRaw?.quality ?? {};
  const badChannels = Object.entries(quality).filter(([, q]) => q === "bad").map(([c]) => c);
  const isReplay = !!ready && info.session.mode === "replay";
  const agreement = useMemo(() => {
    const judged = points.filter((p) => p.truth && !p.unreliable);
    if (!judged.length) return null;
    return judged.filter((p) => (p.score < settings.rules.end_above) === (p.truth === "distracted")).length / judged.length;
  }, [points, settings.rules.end_above]);
  const warnings: string[] = [];
  if (artifacts.has("blink")) warnings.push("Blink on Fp1");
  if (artifacts.has("movement")) warnings.push("Movement on most channels");
  if (badChannels.length) warnings.push(`Lost or poor contact: ${badChannels.join(", ")}`);
  else if (artifacts.has("lost_contact")) warnings.push("A channel has gone flat");
  const unreliable = !!latest?.unreliable || artifacts.has("movement");

  if (info === null) return <div className="page"><p className="muted">Loading session</p></div>;
  if (info === "missing") return <div className="page"><h1>Session not found</h1><p><Link to="/sessions">Back to sessions</Link></p></div>;

  const hw = latest ? (latest.hi - latest.lo) / 2 : 0;

  return (
    <div className="watch">
      <header className="watch__bar">
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{info.lecture.title}</h1>
          <span className="small muted">{info.session.participant_id}, {isReplay ? "replay of recorded BBBD data" : "live headset"}, {fmtTime(t)} of {fmtTime(info.lecture.length_s)}</span>
        </div>
        <span className="spacer" />
        <ConnectionStatus state={conn} kind={source.kind} />
        <label className="small" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />Captions
        </label>
        <div style={{ position: "relative" }}>
          <button className="btn" onClick={() => setMarkerOpen((o) => !o)} aria-expanded={markerOpen} aria-haspopup="menu">
            Add marker <span className="kbd" aria-hidden>M</span>
          </button>
          {markerOpen && <MarkerMenu at={t} onPick={addMarker} onClose={() => setMarkerOpen(false)} />}
        </div>
        <button className="btn btn--primary" onClick={stop} disabled={stopping}>Stop recording</button>
      </header>

      <div className="watch__top">
        <div className="watch__video">
          <VideoPlayer ref={video} src={info.lecture.video || undefined} youtube={info.lecture.youtube} length_s={info.lecture.length_s}
            title={info.lecture.title} transcript={transcript} captions={captions} onState={onVideoState} onEnded={() => setEnded(true)} forceSim={forceSimVideo()} />
          {intervention && <InterventionOverlay event={intervention} onChoice={respond} />}
          {ended && !intervention && (
            <div role="status" style={{ position: "absolute", left: 12, bottom: 64, background: "var(--raised)", border: "1px solid var(--rule-strong)",
              borderRadius: 4, padding: "10px 14px", display: "flex", gap: 12, alignItems: "center", zIndex: 4 }}>
              <span>The lecture has finished.</span>
              <button className="btn btn--primary btn--small" onClick={stop}>Stop recording and view recap</button>
            </div>
          )}
        </div>

        <aside className="watch__side" aria-label="Live readouts">
          <section className="watch__readout" aria-live="polite">
            <div className="small muted">Focus estimate, smoothed over {settings.rules.smoothing_s} s</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span className="num" style={{ fontSize: 28, fontWeight: 600, opacity: unreliable ? 0.45 : 1 }}>{latest ? latest.score.toFixed(2) : "–"}</span>
              <span className="num muted">{latest ? `±${hw.toFixed(2)}` : ""}</span>
              {latestRaw && <FocusStatus state={unreliable ? "unknown" : latestRaw.state} />}
            </div>
            {unreliable && latest && <p className="small" style={{ color: "var(--signal)" }}>Unreliable right now: signal quality is too low to estimate focus.</p>}
            <p className="small muted" style={{ marginTop: 4 }}>Range shows uncertainty ({UNCERTAINTY_SOURCE(focus)}). Calibrated to {info.session.participant_id} only.</p>
            {openLapse != null && <p className="small" style={{ marginTop: 6 }}><span className="status status--warn"><Icon name="warn" />Possible lapse since {fmtTime(openLapse)}</span></p>}
            {isReplay && (
              <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--rule)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <div><div className="small muted">True label now</div><div style={{ fontWeight: 500 }}>{latest?.truth === "distracted" ? "Distracted (counting)" : latest?.truth ? "Attentive" : "–"}</div></div>
                <div><div className="small muted">Model agrees</div><div className="num" style={{ fontWeight: 500 }}>{agreement == null ? "–" : `${Math.round(agreement * 100)}% of seconds`}</div></div>
              </div>
            )}
          </section>

          <section className="watch__panel"><BandPowerPanel latest={bands} history={engHist} /></section>

          <section className="watch__panel" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 12, alignItems: "center" }}>
            <HeadMap channels={settings.montage} quality={quality} size={96} compact />
            <div style={{ display: "grid", gap: 6 }}>
              <div className="small">
                <strong style={{ fontWeight: 500 }}>Signal</strong>{" "}
                <span className="num muted">{Object.values(quality).filter((q) => q !== "bad").length} of {settings.montage.length} usable</span>
              </div>
              {status?.camera?.override && (
                <div className="small">
                  <span className="status status--warn"><Icon name="camera" />Camera override: {status.camera.reason ?? "away"}</span>
                </div>
              )}
            </div>
          </section>

          <section className="watch__panel" aria-label="Camera">
            <div className="small" style={{ marginBottom: 6 }}><strong style={{ fontWeight: 500 }}>Camera</strong>
              <span className="muted"> {cam.running ? "sent to the backend each second" : "off: only EEG is used"}</span></div>
            <CameraPanel compact />
          </section>
        </aside>
      </div>

      <section className="watch__traces" aria-label="EEG traces">
        <div className="watch__strip">
          <h2 style={{ fontSize: 13 }}>EEG</h2>
          <label className="small">Gain <select value={gain} onChange={(e) => setGain(+e.target.value)}>{GAINS.map((g) => <option key={g} value={g}>{g} µV/div</option>)}</select></label>
          <label className="small">Window <select value={windowS} onChange={(e) => setWindowS(+e.target.value)}>{WINDOWS.map((w) => <option key={w} value={w}>{w} s</option>)}</select></label>
          <span className="small muted">1–40 Hz, {settings.notch} Hz notch</span>
          <span className="spacer" />
          <div role="status" aria-live="polite" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {warnings.map((w) => <span key={w} className="status status--warn"><Icon name="warn" />{w}</span>)}
            {warnings.length > 0 && <span className="small muted">Focus estimate marked unreliable during artifacts</span>}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <TraceViewer live channels={settings.montage} gain={gain} windowS={windowS} notch={settings.notch}
            onArtifacts={setArtifacts} ariaLabel="Live 8-channel EEG traces" />
        </div>
      </section>

      <section className="watch__timeline" aria-label="Focus estimate over the lecture">
        <div className="watch__strip">
          <h2 style={{ fontSize: 13 }}>Focus estimate over the lecture</h2>
          <span className="small muted">Shaded: possible lapses. Hatched: unreliable. Dashed lines: lapse start and end thresholds.</span>
          <span className="spacer" />
          {isReplay && <span className="small muted" style={{ display: "flex", gap: 10 }}>
            <span><span aria-hidden style={{ display: "inline-block", width: 10, height: 8, background: "var(--truth-attentive)", marginRight: 4 }} />Attentive</span>
            <span><span aria-hidden style={{ display: "inline-block", width: 10, height: 8, background: "var(--truth-distracted)", marginRight: 4 }} />Distracted (true label)</span>
          </span>}
        </div>
        <FocusTimeline points={points} duration={info.lecture.length_s} lapses={lapses} openLapseStart={openLapse} markers={markers}
          thresholds={{ start: settings.rules.start_below, end: settings.rules.end_above }} showTruth={isReplay} playhead={t}
          onSeek={(s) => video.current?.seek(s)} height={150}
          ariaLabel={`Focus estimate timeline, ${lapses.length} possible lapses so far`} />
      </section>
    </div>
  );
}

function MarkerMenu({ at, onPick, onClose }: { at: number; onPick: (label: string) => void; onClose: () => void }) {
  const [custom, setCustom] = useState("");
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div role="menu" aria-label={`Add marker at ${fmtTime(at)}`} style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 20,
      background: "var(--raised)", border: "1px solid var(--rule-strong)", borderRadius: 4, boxShadow: "var(--shadow-overlay)", width: 240, padding: 6 }}>
      <p className="small muted" style={{ padding: "4px 8px" }}>Marker at {fmtTime(at)}</p>
      {MARKER_PRESETS.map((m, i) => (
        <button key={m} ref={i === 0 ? first : undefined} role="menuitem" className="btn btn--quiet" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => onPick(m)}>{m}</button>
      ))}
      <form onSubmit={(e) => { e.preventDefault(); if (custom.trim()) onPick(custom.trim()); }} style={{ display: "flex", gap: 6, padding: 6, borderTop: "1px solid var(--rule)", marginTop: 4 }}>
        <input type="text" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Custom marker label" style={{ flex: 1, minWidth: 0 }} />
        <button className="btn btn--small" type="submit">Add</button>
      </form>
    </div>
  );
}
