import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { InterventionMode, Lecture, Participant, RunMode, SessionSummary } from "../data/types";
import { useSource } from "../state/source";
import { useSettings } from "../state/settings";
import { fmtDate, fmtDuration, pct } from "../lib/format";
import { Icon } from "../components/Status";

const STATUS: Record<SessionSummary["status"], { word: string; cls: string; icon: "good" | "check" | "ring" | "dot" }> = {
  complete: { word: "Complete", cls: "good", icon: "good" },
  recording: { word: "Recording", cls: "check", icon: "dot" },
  scheduled: { word: "Scheduled", cls: "neutral", icon: "ring" },
  stopped: { word: "Stopped", cls: "neutral", icon: "check" },
};

export function Sessions() {
  const { source } = useSource();
  const nav = useNavigate();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [creating, setCreating] = useState<Partial<SessionSummary> | null>(null);

  useEffect(() => {
    source.listSessions().then(setSessions).catch(() => setSessions([]));
    source.listLectures().then(setLectures).catch(() => setLectures([]));
  }, [source]);

  const open = (s: SessionSummary) => {
    if (s.status === "complete" || s.status === "stopped") nav(`/recap/${s.run_id}`);
    else if (s.status === "recording") nav(`/watch/${s.run_id}`);
    else setCreating(s);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Sessions</h1>
          <p>Each session records one participant watching one lecture.</p>
        </div>
        <button className="btn btn--primary" onClick={() => setCreating({})}>New session</button>
      </div>

      {sessions === null ? <p className="muted">Loading sessions</p> : sessions.length === 0 ? (
        <div className="panel empty">
          <h2>No sessions yet</h2>
          <p className="muted">To record your first session:</p>
          <ol>
            <li>Select <strong>New session</strong> and pick a lecture and participant.</li>
            <li>Choose <strong>Replay</strong> to run on recorded BBBD data with no headset, or <strong>Live</strong> to use the NeuroPawn board.</li>
            <li>For live sessions, check electrode contact, then run the 10-minute calibration before the lecture.</li>
          </ol>
        </div>
      ) : (
        <div className="panel panel--primary" style={{ overflowX: "auto" }}>
          <table className="table">
            <thead><tr>
              <th>Lecture</th><th>Date</th><th>Participant</th><th className="r">Duration</th><th>Mode</th>
              <th className="r">Focused (estimate)</th><th>Status</th><th><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.run_id} className="clickable" onClick={() => open(s)}>
                  <td><strong style={{ fontWeight: 500 }}>{s.lecture_title}</strong></td>
                  <td className="num">{fmtDate(s.date)}</td>
                  <td>{s.participant_id}</td>
                  <td className="r num">{fmtDuration(s.duration_s)}</td>
                  <td><span className="tag">{s.mode === "live" ? "Live" : "Replay"}</span></td>
                  <td className="r num">{s.focused_fraction != null ? pct(s.focused_fraction) : "–"}</td>
                  <td><span className={`status status--${STATUS[s.status].cls}`}><Icon name={STATUS[s.status].icon} />{STATUS[s.status].word}</span></td>
                  <td className="r">
                    <button className="btn btn--small" onClick={(e) => { e.stopPropagation(); open(s); }}>
                      {s.status === "scheduled" ? "Start" : s.status === "recording" ? "Open" : "View recap"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewSession lectures={lectures} preset={creating} onClose={() => setCreating(null)} />}
    </div>
  );
}

function NewSession({ lectures, preset, onClose }: { lectures: Lecture[]; preset: Partial<SessionSummary>; onClose: () => void }) {
  const { source } = useSource();
  const { settings, update } = useSettings();
  const nav = useNavigate();
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [lecture, setLecture] = useState(preset.lecture_id ?? lectures[0]?.id ?? "");
  const [participant, setParticipant] = useState(preset.participant_id ?? "");
  const [mode, setMode] = useState<RunMode>(preset.mode ?? "replay");
  const [intervention, setIntervention] = useState<InterventionMode>(settings.intervention);
  const [sensitivity, setSensitivity] = useState(settings.sensitivity);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { source.listParticipants().then((p) => { setParticipants(p); setParticipant((x) => x || p[0]?.id || ""); }); }, [source]);
  useEffect(() => { if (!lecture && lectures[0]) setLecture(lectures[0].id); }, [lectures, lecture]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);

  const p = participants.find((x) => x.id === participant);
  const consentMissing = p && !p.consent_eeg;

  const start = async () => {
    setBusy(true); setError("");
    try {
      update({ intervention, sensitivity });
      const { run_id } = await source.startSession({ lecture_id: lecture, participant_id: participant, mode, intervention, sensitivity });
      nav(mode === "live" ? `/setup/${run_id}` : `/watch/${run_id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not start the session"); setBusy(false); }
  };

  return (
    <div className="overlay-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="new-session-title">
        <div className="dialog__head"><h2 id="new-session-title">New session</h2></div>
        <div className="dialog__body">
          <label className="field"><span>Lecture</span>
            <select value={lecture} onChange={(e) => setLecture(e.target.value)} autoFocus>
              {lectures.map((l) => <option key={l.id} value={l.id}>{l.title} ({Math.round(l.length_s / 60)} min)</option>)}
            </select>
          </label>
          <label className="field"><span>Participant</span>
            <select value={participant} onChange={(e) => setParticipant(e.target.value)}>
              {participants.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          {consentMissing && <div className="notice notice--warn"><Icon name="warn" />This participant has not consented to EEG recording. Record consent on their page first.</div>}
          <div className="field"><span>Mode</span>
            <div className="segmented" role="group" aria-label="Mode">
              <button aria-pressed={mode === "replay"} onClick={() => setMode("replay")}>Replay (no headset)</button>
              <button aria-pressed={mode === "live"} onClick={() => setMode("live")}>Live headset</button>
            </div>
            <span className="small muted">{mode === "replay"
              ? "Recorded BBBD sessions in alternating attentive and distracted minutes, with the true label shown."
              : "Device setup and a 10-minute calibration come first. The model only works for a calibrated person."}</span>
          </div>
          <div className="field"><span>When a lapse is detected</span>
            <div className="segmented" role="group" aria-label="When a lapse is detected">
              <button aria-pressed={intervention === "pause"} onClick={() => setIntervention("pause")}>Pause the video</button>
              <button aria-pressed={intervention === "alert"} onClick={() => setIntervention("alert")}>Show a note</button>
              <button aria-pressed={intervention === "recap"} onClick={() => setIntervention("recap")}>Recap only</button>
            </div>
          </div>
          <label className="field"><span>Sensitivity: {sensitivity < 0.4 ? "fewer alerts" : sensitivity > 0.6 ? "more alerts" : "balanced"}</span>
            <input type="range" min={0} max={1} step={0.05} value={sensitivity} onChange={(e) => setSensitivity(+e.target.value)} />
          </label>
          {error && <div className="notice notice--warn"><Icon name="warn" />{error}</div>}
        </div>
        <div className="dialog__foot">
          <button className="btn btn--quiet" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={busy || !lecture || !participant || !!consentMissing} onClick={start}>
            {mode === "live" ? "Start device setup" : "Start replay"}
          </button>
        </div>
      </div>
    </div>
  );
}
