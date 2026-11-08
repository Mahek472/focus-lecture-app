import { useSettings, DEFAULT_MONTAGE, TEN_TEN } from "../state/settings";
import { useSource } from "../state/source";
import type { InterventionMode } from "../data/types";

export function SettingsScreen() {
  const { settings: s, update, reset } = useSettings();
  const { source } = useSource();
  const rules = s.rules;
  const setRule = (k: keyof typeof rules, v: number) => update({ rules: { ...rules, [k]: v } });
  const dupes = s.montage.filter((c, i) => s.montage.indexOf(c) !== i);

  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <div className="page-head">
        <div><h1>Settings</h1><p>Saved in this browser. The backend applies the lapse rules; these values must match its configuration.</p></div>
        <button className="btn" onClick={reset}>Restore defaults</button>
      </div>

      <section className="panel">
        <div className="panel__head"><h2>Model</h2></div>
        <div className="panel__body" style={{ display: "grid", gap: 10 }}>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <input type="radio" name="model" checked readOnly style={{ marginTop: 4 }} />
            <span><strong style={{ fontWeight: 500 }}>Per-user Riemannian classifier</strong> (Tang et al. 2023 recipe)<br />
              <span className="small muted">Four bands, covariance, tangent space, logistic regression, trained on each person's calibration. BBBD, our 8 channels: AUC 0.87 calibrated, 0.64–0.70 for a new person.</span></span>
          </label>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", opacity: 0.6 }}>
            <input type="radio" name="model" disabled style={{ marginTop: 4 }} />
            <span><strong style={{ fontWeight: 500 }}>CBraMod foundation model</strong>: evaluated, not used<br />
              <span className="small muted">The frozen probe scored 0.68 calibrated, 0.19 below the Riemannian model, so fine-tuning was not pursued.</span></span>
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="panel__head"><h2>Lapses and alerts</h2></div>
        <div className="panel__body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
          <label className="field"><span>Lapse starts below</span><input type="number" step={0.05} min={0} max={1} value={rules.start_below} onChange={(e) => setRule("start_below", +e.target.value)} /></label>
          <label className="field"><span>…for this many seconds</span><input type="number" min={1} value={rules.start_for_s} onChange={(e) => setRule("start_for_s", +e.target.value)} /></label>
          <label className="field"><span>Lapse ends above</span><input type="number" step={0.05} min={0} max={1} value={rules.end_above} onChange={(e) => setRule("end_above", +e.target.value)} /></label>
          <label className="field"><span>…for this many seconds</span><input type="number" min={1} value={rules.end_for_s} onChange={(e) => setRule("end_for_s", +e.target.value)} /></label>
          <label className="field"><span>Smoothing window (s)</span><input type="number" min={1} value={rules.smoothing_s} onChange={(e) => setRule("smoothing_s", +e.target.value)} /></label>
          <label className="field"><span>Camera override after (s)</span><input type="number" min={1} value={rules.camera_override_s} onChange={(e) => setRule("camera_override_s", +e.target.value)} /></label>
          <label className="field"><span>Intervene after a lapse of (s)</span><input type="number" min={1} value={rules.intervention_after_s} onChange={(e) => setRule("intervention_after_s", +e.target.value)} /></label>
          <label className="field"><span>Cooldown between interventions (s)</span><input type="number" min={0} value={rules.cooldown_s} onChange={(e) => setRule("cooldown_s", +e.target.value)} /></label>
          <div className="field"><span>Default when a lapse is detected</span>
            <select value={s.intervention} onChange={(e) => update({ intervention: e.target.value as InterventionMode })}>
              <option value="pause">Pause the video</option><option value="alert">Show a note</option><option value="recap">Recap only</option>
            </select>
          </div>
          <label className="field"><span>Default sensitivity ({s.sensitivity.toFixed(2)})</span>
            <input type="range" min={0} max={1} step={0.05} value={s.sensitivity} onChange={(e) => update({ sensitivity: +e.target.value })} />
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="panel__head"><h2>Signal</h2></div>
        <div className="panel__body" style={{ display: "grid", gap: 16 }}>
          <div className="field"><span>Notch filter (mains frequency)</span>
            <div className="segmented" role="group" aria-label="Notch filter">
              <button aria-pressed={s.notch === 60} onClick={() => update({ notch: 60 })}>60 Hz (North America)</button>
              <button aria-pressed={s.notch === 50} onClick={() => update({ notch: 50 })}>50 Hz</button>
            </div>
          </div>
          <div>
            <h3 style={{ marginBottom: 8 }}>Channel montage</h3>
            <p className="small muted" style={{ marginBottom: 8 }}>Which 10-10 position each board channel is wired to. Default: P3, Fz, Cz, Fp1, P4, Pz, O1, O2.</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10 }}>
              {s.montage.map((c, i) => (
                <label key={i} className="field"><span>Board channel {i + 1}</span>
                  <select value={c} onChange={(e) => { const m = [...s.montage]; m[i] = e.target.value; update({ montage: m }); }}
                    aria-invalid={dupes.includes(c)}>
                    {TEN_TEN.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
              ))}
            </div>
            {dupes.length > 0 && <p className="small" style={{ color: "var(--signal)", marginTop: 8 }}>{[...new Set(dupes)].join(", ")} is assigned to more than one channel.</p>}
            <button className="btn btn--small" style={{ marginTop: 10 }} onClick={() => update({ montage: DEFAULT_MONTAGE })}>Reset montage</button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel__head"><h2>Display and accessibility</h2></div>
        <div className="panel__body" style={{ display: "grid", gap: 12 }}>
          <div className="field"><span>Theme</span>
            <div className="segmented" role="group" aria-label="Theme">
              {(["system", "light", "dark"] as const).map((t) => (
                <button key={t} aria-pressed={s.theme === t} onClick={() => update({ theme: t })}>{t === "system" ? "Match system" : t === "light" ? "Light" : "Dark"}</button>
              ))}
            </div>
          </div>
          <label style={{ display: "flex", gap: 8 }}><input type="checkbox" checked={s.captions} onChange={(e) => update({ captions: e.target.checked })} />Captions on by default</label>
        </div>
      </section>

      <section className="panel">
        <div className="panel__head"><h2>Data source</h2></div>
        <div className="panel__body" style={{ display: "grid", gap: 12 }}>
          <p>{source.kind === "mock"
            ? "Mock data, simulated in the browser. Set VITE_DATA_SOURCE=websocket to use the backend."
            : "FastAPI backend on :8000 (REST and /ws), signal checker on :8766."}</p>
          {source.kind === "mock" && (
            <>
              <div className="field"><span>Calibration block length (mock)</span>
                <div className="segmented" role="group" aria-label="Calibration block length">
                  <button aria-pressed={s.calibrationBlockS === 60} onClick={() => update({ calibrationBlockS: 60 })}>60 s, as in a real session</button>
                  <button aria-pressed={s.calibrationBlockS === 10} onClick={() => update({ calibrationBlockS: 10 })}>10 s, quick demo</button>
                </div>
              </div>
              <label style={{ display: "flex", gap: 8 }}><input type="checkbox" checked={s.mockHum} onChange={(e) => update({ mockHum: e.target.checked })} />Add 60 Hz mains hum to the simulated EEG</label>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
