import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Quality, SerialPortInfo, SignalCheckUpdate } from "../data/types";
import { useSource } from "../state/source";
import { useSettings } from "../state/settings";
import { HeadMap } from "../components/HeadMap";
import { TraceViewer } from "../components/TraceViewer";
import { Icon } from "../components/Status";
import { CameraPanel } from "../components/CameraPanel";

// Thresholds match scripts/live_signal.py: noise SD over 2 s, good < 30 uV, ok 30-60, poor > 60, flat < 0.5.
type Contact = "good" | "ok" | "poor" | "flat";
const contactOf = (sd: number): Contact => (sd < 0.5 ? "flat" : sd < 30 ? "good" : sd <= 60 ? "ok" : "poor");
const toQuality: Record<Contact, Quality> = { good: "good", ok: "check", poor: "bad", flat: "bad" };
const CONTACT_WORD: Record<Contact, string> = { good: "Good", ok: "Ok", poor: "Poor", flat: "Flat" };
const MUST_BE_OK = ["Fp1", "O1", "O2"];

type StepId = "blink" | "clench" | "eyes";
const STEPS: { id: StepId; title: string; say: string; expect: string; seconds: number }[] = [
  { id: "blink", title: "Blink", say: "Blink hard three times.", expect: "Large spikes on Fp1.", seconds: 6 },
  { id: "clench", title: "Clench", say: "Clench your teeth for two seconds, then relax.", expect: "Noise bursts on every channel.", seconds: 6 },
  { id: "eyes", title: "Eyes closed", say: "Close your eyes and relax for ten seconds.", expect: "Alpha share rises at O1 and O2.", seconds: 10 },
];

export function DeviceSetup() {
  const { runId } = useParams();
  const nav = useNavigate();
  const { source } = useSource();
  const { settings } = useSettings();
  const ch = settings.montage;
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [port, setPort] = useState("");
  const [rld, setRld] = useState(true);
  const [connected, setConnected] = useState(false);
  const [u, setU] = useState<SignalCheckUpdate>({ ready: false });
  const [selected, setSelected] = useState("Fp1");
  const [steps, setSteps] = useState<Record<StepId, "todo" | "running" | "seen" | "missed">>({ blink: "todo", clench: "todo", eyes: "todo" });
  const stepRef = useRef<{ id: StepId; base: SignalCheckUpdate; until: number } | null>(null);

  const refreshPorts = () =>
    source.listPorts().then((p) => { setPorts(p); setPort((cur) => (p.some((x) => x.port === cur) ? cur : p.find((x) => /usb/i.test(x.description))?.port ?? p[0]?.port ?? cur)); });
  useEffect(() => { void refreshPorts(); }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!connected) return;
    return source.startSignalCheck(port, rld, (x) => {
      setU(x);
      const st = stepRef.current;
      if (!st || !x.ready) return;
      const seen = detect(st.id, st.base, x, ch);
      if (seen) { setSteps((s) => ({ ...s, [st.id]: "seen" })); finishStep(st.id); }
      else if (Date.now() > st.until) { setSteps((s) => ({ ...s, [st.id]: "missed" })); finishStep(st.id); }
    });
  }, [connected, port, rld, source]); // eslint-disable-line react-hooks/exhaustive-deps

  const finishStep = (id: StepId) => { stepRef.current = null; if (id === "eyes") source.simulate?.("eyes_open"); };
  const runStep = (id: StepId) => {
    const s = STEPS.find((x) => x.id === id)!;
    stepRef.current = { id, base: u, until: Date.now() + s.seconds * 1000 };
    setSteps((x) => ({ ...x, [id]: "running" }));
    if (source.kind === "mock") {   // the mock plays the participant
      if (id === "blink") [0, 700, 1400].forEach((d) => setTimeout(() => source.simulate?.("blink"), 600 + d));
      if (id === "clench") setTimeout(() => source.simulate?.("clench"), 800);
      if (id === "eyes") setTimeout(() => source.simulate?.("eyes_closed"), 500);
    }
  };

  const contacts = useMemo(() => ch.map((_, i) => (u.ready && u.sd ? contactOf(u.sd[i]) : null)), [u, ch]);
  const okCount = contacts.filter((c) => c === "good" || c === "ok").length;
  const needFix = ch.filter((_, i) => contacts[i] === "poor" || contacts[i] === "flat");
  const mustBad = MUST_BE_OK.filter((name) => needFix.includes(name));
  const ready = u.ready && okCount >= 7 && mustBad.length === 0;
  const allBad = u.ready && needFix.length >= 6;
  const sel = ch.indexOf(selected);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Device setup</h1>
          <p>Connect the board, then adjust electrodes until enough of them have good contact.</p>
        </div>
        <div className="toolbar">
          <Link className="btn btn--quiet" to="/sessions">Cancel</Link>
          <button className="btn btn--primary" disabled={!ready} onClick={() => nav(`/calibration/${runId}`)}>Continue to calibration</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 320px) minmax(0, 1fr) minmax(0, 1.3fr)", gap: 16, alignItems: "start" }} className="setup-grid">
        <section className="panel" aria-labelledby="conn-h">
          <div className="panel__head"><h2 id="conn-h">Board connection</h2></div>
          <div className="panel__body" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}>
            <div className="notice notice--info">Close the NeuroPawn EXG Visualizer first. Only one program can use the board at a time.</div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", minWidth: 0 }}>
              {ports.length ? (
                <label className="field" style={{ flex: 1, minWidth: 0 }}><span>Serial port</span>
                  <select style={{ width: "100%", minWidth: 0, textOverflow: "ellipsis" }} value={port} onChange={(e) => setPort(e.target.value)} disabled={connected}>
                    {ports.map((p) => <option key={p.port} value={p.port}>{p.port}: {p.description}</option>)}
                  </select>
                </label>
              ) : (
                <label className="field" style={{ flex: 1, minWidth: 0 }}><span>Serial port (no ports found: plug in the board and refresh)</span>
                  <input type="text" value={port} onChange={(e) => setPort(e.target.value.toUpperCase())} placeholder="COM7" disabled={connected} style={{ width: "100%", minWidth: 0 }} />
                </label>
              )}
              <button className="btn" disabled={connected} onClick={refreshPorts}>Refresh</button>
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={rld} onChange={(e) => setRld(e.target.checked)} disabled={connected} />
              Route RLD on every channel
            </label>
            {!connected
              ? <button className="btn btn--primary" disabled={!port} onClick={() => setConnected(true)}>Connect board</button>
              : <button className="btn" onClick={() => { setConnected(false); setU({ ready: false }); }}>Disconnect</button>}
            {connected && !u.ready && !u.error && <p className="small muted">Connecting to {port} and switching on the channels. The first data takes about 20 seconds.</p>}
            {connected && u.error && <div className="notice notice--warn"><Icon name="warn" />Couldn't read the board on {port}: {u.error}. Check the cable and that the EXG Visualizer is closed, then Disconnect and Connect again.</div>}
            {source.kind === "websocket" && <p className="small muted">Disconnecting, or leaving this page, releases the board for recording.</p>}
          </div>
        </section>

        <section className="panel panel--primary" aria-labelledby="map-h">
          <div className="panel__head"><h2 id="map-h">Contact quality</h2><span className="spacer" />
            <span className="small muted num">{u.ready ? `${okCount} of ${ch.length} good or ok` : "No data"}</span></div>
          <div className="panel__body" style={{ display: "grid", justifyItems: "center", gap: 12 }}>
            <HeadMap channels={ch} selected={selected} onSelect={setSelected}
              quality={Object.fromEntries(ch.map((c, i) => [c, contacts[i] ? toQuality[contacts[i]!] : undefined]))}
              values={u.sd ? Object.fromEntries(ch.map((c, i) => [c, `${Math.round(u.sd![i])} µV`])) : undefined} />
            <div style={{ width: "100%" }}>
              {!u.ready ? <p className="small muted">Connect the board to see each electrode's contact.</p>
                : ready ? <div className="notice notice--info"><Icon name="good" />Contact is good enough to calibrate.
                    {needFix.length > 0 && ` ${needFix.join(", ")} is still poor; reseating it would help but isn't required.`}</div>
                : (
                  <div className="notice notice--warn" style={{ display: "block" }}>
                    <p style={{ fontWeight: 500, marginBottom: 4 }}>Adjust before continuing: {needFix.join(", ")}</p>
                    {allBad
                      ? <p>Almost every channel is poor at once, which points to the ear clip. Check it is on the earlobe with wires in RLD and COMM.</p>
                      : <p>Part the hair under each one, add a little conductive paste, and press the electrode onto the scalp.</p>}
                    {mustBad.length > 0 && <p style={{ marginTop: 4 }}>{mustBad.join(", ")} must not be poor: Fp1 catches blinks, O1 and O2 carry the alpha the model relies on.</p>}
                    {source.kind === "mock" && <button className="btn btn--small" style={{ marginTop: 8 }} onClick={() => source.simulate?.("fix_contact")}>Simulate reseating electrodes</button>}
                  </div>
                )}
            </div>
          </div>
        </section>

        <section className="panel" aria-labelledby="trace-h">
          <div className="panel__head"><h2 id="trace-h">{selected} live trace</h2><span className="spacer" />
            <span className="small muted">last 5 s, 1–40 Hz, 60 Hz notch</span></div>
          <div className="panel__body" style={{ height: 150 }}>
            {u.ready && u.traces && sel >= 0
              ? <TraceViewer channels={[selected]} data={{ sfreq: (u.sfreq ?? 125) / 2, samples: [u.traces[sel]] }} gain={100}
                  windowS={5} notch={settings.notch} ariaLabel={`Live trace for ${selected}`} />
              : <p className="small muted">Select an electrode on the map to see its trace.</p>}
          </div>
          <table className="table" style={{ fontSize: 13 }}>
            <thead><tr><th>Electrode</th><th>Contact</th><th className="r">Noise</th><th className="r">60 Hz hum</th><th className="r">Alpha share</th></tr></thead>
            <tbody>
              {ch.map((c, i) => {
                const k = contacts[i];
                return (
                  <tr key={c} className="clickable" onClick={() => setSelected(c)} aria-selected={c === selected}
                    style={c === selected ? { background: "var(--accent-soft)" } : undefined}>
                    <td>{c}</td>
                    <td>{k ? <span className={`status status--${toQuality[k]}`}><Icon name={toQuality[k]} />{CONTACT_WORD[k]}</span> : "–"}</td>
                    <td className="r num">{u.sd ? `${u.sd[i].toFixed(0)} µV` : "–"}</td>
                    <td className="r num">{u.hum ? <span className={u.hum[i] > 1 ? "status status--warn" : ""}>{u.hum[i].toFixed(2)}</span> : "–"}</td>
                    <td className="r num">{u.alpha ? `${Math.round(u.alpha[i] * 100)}%` : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>

      <section className="panel" aria-labelledby="cam-h">
        <div className="panel__head"><h2 id="cam-h">Camera check</h2><span className="spacer" />
          <span className="small muted">Face, head and eyes, and gaze calibration for this person and screen</span></div>
        <div className="panel__body"><CameraPanel /></div>
      </section>

      <section className="panel" aria-labelledby="check-h">
        <div className="panel__head"><h2 id="check-h">Guided signal check</h2><span className="spacer" />
          <span className="small muted">Optional, but catches swapped wires and dead electrodes</span></div>
        <div className="panel__body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          {STEPS.map((s, i) => {
            const st = steps[s.id];
            return (
              <div key={s.id} style={{ borderLeft: "3px solid var(--rule)", paddingLeft: 12 }}>
                <h3>{i + 1}. {s.title}</h3>
                <p style={{ margin: "4px 0" }}>Say: "{s.say}"</p>
                <p className="small muted">Expect: {s.expect}</p>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                  <button className="btn btn--small" disabled={!u.ready || st === "running"} onClick={() => runStep(s.id)}>
                    {st === "todo" ? "Start" : st === "running" ? "Watching" : "Run again"}
                  </button>
                  {st === "seen" && <span className="status status--good"><Icon name="good" />Seen</span>}
                  {st === "missed" && <span className="status status--warn"><Icon name="warn" />Not seen: check {s.id === "blink" ? "Fp1" : s.id === "eyes" ? "O1, O2 and the reference" : "all electrodes"}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <style>{`@media (max-width: 1180px) { .setup-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) !important; } }
               @media (max-width: 760px) { .setup-grid { grid-template-columns: minmax(0, 1fr) !important; } }
               .setup-grid > .panel { min-width: 0; }`}</style>
    </div>
  );
}

function detect(id: StepId, base: SignalCheckUpdate, x: SignalCheckUpdate, ch: string[]) {
  if (!base.ready || !x.ptp || !x.sd || !base.ptp || !base.sd) return false;
  if (id === "blink") { const i = ch.indexOf("Fp1"); return i >= 0 && x.ptp[i] > Math.max(80, 2.5 * base.ptp[i]); }
  if (id === "clench") return x.sd.filter((v, i) => v > 2 * base.sd![i]).length >= 6;
  const occ = ["O1", "O2"].map((c) => ch.indexOf(c)).filter((i) => i >= 0);
  return !!x.alpha && !!base.alpha && occ.some((i) => x.alpha![i] >= 1.5 * Math.max(0.02, base.alpha![i]));
}
