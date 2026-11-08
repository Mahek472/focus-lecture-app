import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Participant, SessionSummary } from "../data/types";
import { useSource } from "../state/source";
import { Icon } from "../components/Status";
import { fmtDate, fmtDuration, pct } from "../lib/format";

function Consent({ ok, what }: { ok: boolean; what: string }) {
  return <span className={`status status--${ok ? "good" : "neutral"}`}><Icon name={ok ? "good" : "ring"} />{what}: {ok ? "yes" : "no"}</span>;
}

function Calib({ p }: { p: Participant }) {
  if (p.calibration_auc == null) return <span className="muted">Not calibrated</span>;
  const ok = p.calibration_auc >= 0.7;
  return <span className={`status status--${ok ? "good" : "check"}`}><Icon name={ok ? "good" : "check"} />AUC {p.calibration_auc.toFixed(2)}, {p.calibration_date}</span>;
}

export function Participants() {
  const { source } = useSource();
  const nav = useNavigate();
  const [list, setList] = useState<Participant[] | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => { source.listParticipants().then(setList); }, [source]);

  const add = async () => {
    const n = (list?.length ?? 0) + 1;
    const id = `P${String(n).padStart(2, "0")}`;
    const p: Participant = { id, name: `Participant ${id}`, consent_eeg: false, consent_webcam: false, notes: "" };
    setAdding(true);
    await source.saveParticipant(p);
    nav(`/participants/${id}`);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Participants</h1><p>People who have agreed to be recorded. The model is calibrated per person.</p></div>
        <button className="btn btn--primary" onClick={add} disabled={adding}>Add participant</button>
      </div>
      {list === null ? <p className="muted">Loading</p> : list.length === 0 ? (
        <div className="panel empty"><h2>No participants yet</h2><p className="muted">Add a participant, record their consent, then start a session for them.</p></div>
      ) : (
        <div className="panel panel--primary" style={{ overflowX: "auto" }}>
          <table className="table">
            <thead><tr><th>Participant</th><th>Consent</th><th>Calibration</th><th>Notes</th></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => nav(`/participants/${p.id}`)}>
                  <td><Link to={`/participants/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.name}</Link></td>
                  <td style={{ display: "flex", gap: 12, flexWrap: "wrap" }}><Consent ok={p.consent_eeg} what="EEG" /><Consent ok={p.consent_webcam} what="Webcam" /></td>
                  <td><Calib p={p} /></td>
                  <td className="muted small" style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.notes || "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ParticipantDetail() {
  const { id = "" } = useParams();
  const { source } = useSource();
  const nav = useNavigate();
  const [p, setP] = useState<Participant | null | "missing">(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    source.listParticipants().then((l) => setP(l.find((x) => x.id === id) ?? "missing"));
    source.listSessions().then((s) => setSessions(s.filter((x) => x.participant_id === id)));
  }, [source, id]);

  if (p === null) return <div className="page"><p className="muted">Loading</p></div>;
  if (p === "missing") return <div className="page"><h1>Participant not found</h1><Link to="/participants">Back to participants</Link></div>;

  const set = (patch: Partial<Participant>) => { setP({ ...p, ...patch }); setSaved(false); };
  const save = async () => { await source.saveParticipant(p); setSaved(true); };

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="page-head">
        <div><p><Link to="/participants">Participants</Link></p><h1>{p.name}</h1></div>
        <div className="toolbar">
          {saved && <span className="status status--good"><Icon name="good" />Saved</span>}
          <button className="btn btn--primary" onClick={save}>Save changes</button>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 1fr) minmax(0, 1.5fr)", gap: 16, alignItems: "start" }} className="recap-grid">
        <section className="panel">
          <div className="panel__head"><h2>Details and consent</h2></div>
          <div className="panel__body" style={{ display: "grid", gap: 12 }}>
            <label className="field"><span>Name or code</span><input type="text" value={p.name} onChange={(e) => set({ name: e.target.value })} /></label>
            <fieldset style={{ border: "1px solid var(--rule)", borderRadius: 4, padding: "8px 12px", display: "grid", gap: 6 }}>
              <legend className="small muted">Consent given</legend>
              <label style={{ display: "flex", gap: 8 }}><input type="checkbox" checked={p.consent_eeg} onChange={(e) => set({ consent_eeg: e.target.checked })} />EEG recording</label>
              <label style={{ display: "flex", gap: 8 }}><input type="checkbox" checked={p.consent_webcam} onChange={(e) => set({ consent_webcam: e.target.checked })} />Webcam recording of their face</label>
            </fieldset>
            <div className="field"><span>Calibration</span><Calib p={p} /></div>
            <label className="field"><span>Notes</span><textarea value={p.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
          </div>
        </section>
        <section className="panel">
          <div className="panel__head"><h2>Session history</h2></div>
          {sessions.length === 0 ? <p className="panel__body muted">No sessions yet.</p> : (
            <table className="table">
              <thead><tr><th>Lecture</th><th>Date</th><th className="r">Duration</th><th className="r">Focused (estimate)</th></tr></thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.run_id} className="clickable" onClick={() => nav(s.status === "complete" ? `/recap/${s.run_id}` : "/sessions")}>
                    <td>{s.lecture_title}</td>
                    <td className="num">{fmtDate(s.date)}</td>
                    <td className="r num">{fmtDuration(s.duration_s)}</td>
                    <td className="r num">{s.focused_fraction != null ? pct(s.focused_fraction) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
