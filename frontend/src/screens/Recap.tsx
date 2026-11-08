import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { BANDS, type BandPowerUpdate, type Lapse, type Recap as RecapData, type RunHistory } from "../data/types";
import { useSource } from "../state/source";
import { useSettings } from "../state/settings";
import { useRun, type RunInfo } from "../state/useRun";
import { FocusTimeline, type FocusTimelineHandle } from "../components/FocusTimeline";
import { TraceViewer } from "../components/TraceViewer";
import { BandPowerPanel } from "../components/BandPowerPanel";
import { VideoPlayer, type VideoHandle } from "../components/VideoPlayer";
import { Icon } from "../components/Status";
import { toPoints } from "../lib/uncertainty";
import { exportCsv, exportPng } from "../lib/exporters";
import { forceSimVideo } from "../lib/flags";
import { fmtTime, lapseReason, pct } from "../lib/format";

const LANGUAGES = [["en", "English"], ["es", "Español"], ["fr", "Français"], ["hi", "हिन्दी"], ["zh", "中文"]] as const;

export function Recap() {
  const { runId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get("view") === "review" ? "review" : "student";
  const info = useRun(runId);
  const { source, recorder } = useSource();
  const [hist, setHist] = useState<RunHistory | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    (async () => {
      const recorded = recorder.get(runId);
      const h = recorded && recorded.focus.length ? recorded : await source.getRunHistory(runId);
      const backendLapses = await source.getLapses(runId).catch(() => null);
      if (!alive) return;
      setHist(h ? { ...h, lapses: backendLapses?.length ? backendLapses : h.lapses } : null);
    })();
    return () => { alive = false; };
  }, [runId, source, recorder]);

  if (info === null || hist === undefined) return <div className="page"><p className="muted">Loading recap</p></div>;
  if (info === "missing") return <div className="page"><h1>Session not found</h1><Link to="/sessions">Back to sessions</Link></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{info.lecture.title}</h1>
          <p>{info.session.participant_id}, {info.session.mode === "replay" ? "replay session" : "live session"}</p>
        </div>
        <div className="segmented" role="tablist" aria-label="Recap view">
          <button role="tab" aria-selected={tab === "student"} aria-pressed={tab === "student"} onClick={() => setParams({})}>Student recap</button>
          <button role="tab" aria-selected={tab === "review"} aria-pressed={tab === "review"} onClick={() => setParams({ view: "review" })}>Operator review</button>
        </div>
      </div>
      {tab === "student" ? <StudentRecap runId={runId} info={info} hist={hist} /> : <OperatorReview info={info} hist={hist} />}
    </div>
  );
}

// ---------------------------------------------------------------- student

function StudentRecap({ runId, info, hist }: { runId: string; info: RunInfo; hist: RunHistory | null }) {
  const { source } = useSource();
  const { settings } = useSettings();
  const [lang, setLang] = useState("en");
  const [recap, setRecap] = useState<RecapData | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState(0);
  const [view, setView] = useState<"summary" | "cards">("summary");
  const [showTranscript, setShowTranscript] = useState(false);
  const video = useRef<VideoHandle>(null);

  useEffect(() => {
    setRecap(null); setError("");
    source.getRecap(runId, lang).then(setRecap).catch((e) => setError(e instanceof Error ? e.message : "Recap unavailable"));
  }, [source, runId, lang]);

  const items = recap?.items ?? [];
  const item = items[sel];
  const lapses = hist?.lapses ?? items.map((i) => i.lapse);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section className="panel panel--primary">
        <div className="panel__body" style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            {recap ? (
              <p style={{ fontSize: 18 }}>You were focused for about <strong className="num">{pct(recap.focused_fraction)}</strong> of the lecture.
                {lapses.length ? <> You may have missed {lapses.length === 1 ? "one part" : `${lapses.length} parts`}: {lapses.map((l) => `${fmtTime(l.start)}–${fmtTime(l.end)}`).join(", ")}.</> : " No lapses were flagged."}</p>
            ) : <p className="muted">{error || "Preparing your recap"}</p>}
            <p className="small muted" style={{ marginTop: 6 }}>These are estimates from your EEG, calibrated to you. A flagged part means it may be worth a second look, not that you weren't trying.</p>
            {recap?.note && <p className="small muted" style={{ marginTop: 4 }}>{recap.note}</p>}
          </div>
          <label className="field"><span>Recap language</span>
            <select value={lang} onChange={(e) => setLang(e.target.value)}>{LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.6fr)", gap: 16, alignItems: "start" }} className="recap-grid">
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16, minWidth: 0 }}>
          <section className="panel" aria-labelledby="lapses-h">
            <div className="panel__head"><h2 id="lapses-h">Parts you may have missed</h2></div>
            {items.length === 0 ? <p className="panel__body muted">{recap ? "Nothing to review." : "Loading"}</p> : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {items.map((it, i) => (
                  <li key={i} style={{ borderBottom: "1px solid var(--rule)", borderLeft: `3px solid ${i === sel ? "var(--accent)" : "transparent"}`, background: i === sel ? "var(--accent-soft)" : undefined }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px" }}>
                      <button className="btn btn--quiet" style={{ flex: 1, minWidth: 0, justifyContent: "flex-start", padding: 0 }} onClick={() => setSel(i)} aria-pressed={i === sel}>
                        <span className="num" style={{ fontWeight: 500 }}>{fmtTime(it.lapse.start)}–{fmtTime(it.lapse.end)}</span>
                        {lapseReason(it.lapse.reason) && <span className="small muted" style={{ whiteSpace: "nowrap" }}>({lapseReason(it.lapse.reason)})</span>}
                        <span className="small muted" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.summary[0]}</span>
                      </button>
                      <button className="btn btn--small" onClick={() => { setSel(i); video.current?.seek(it.lapse.start); video.current?.play(); }}>Replay this part</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel" aria-label="Lecture video">
            <VideoPlayer ref={video} src={info.lecture.video || undefined} youtube={info.lecture.youtube} length_s={info.lecture.length_s}
              title={info.lecture.title} transcript={info.transcript} captions={settings.captions} onState={() => {}} forceSim={forceSimVideo()} />
          </section>
        </div>

        <section className="panel" aria-labelledby="recap-h">
          <div className="panel__head">
            <h2 id="recap-h">{item ? `What was said ${fmtTime(item.lapse.start)}–${fmtTime(item.lapse.end)}` : "Recap"}</h2>
            <span className="spacer" />
            <div className="segmented" role="tablist" aria-label="Recap format">
              <button role="tab" aria-selected={view === "summary"} aria-pressed={view === "summary"} onClick={() => setView("summary")}>Summary</button>
              <button role="tab" aria-selected={view === "cards"} aria-pressed={view === "cards"} onClick={() => setView("cards")}>Flashcards</button>
            </div>
          </div>
          <div className="panel__body" style={{ minHeight: 200 }}>
            {!item ? <p className="muted">Select a part on the left.</p> : view === "summary" ? (
              <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8, fontSize: 15, lineHeight: 1.55 }}>
                {item.summary.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
                {item.flashcards.map((c, i) => <Flashcard key={`${sel}-${i}`} front={c.front} back={c.back} n={i + 1} />)}
                {item.flashcards.length === 0 && <p className="muted">No flashcards for this part.</p>}
              </div>
            )}
          </div>
          <div style={{ borderTop: "1px solid var(--rule)", padding: "8px 12px" }}>
            <button className="btn btn--quiet btn--small" aria-expanded={showTranscript} onClick={() => setShowTranscript((s) => !s)}>
              {showTranscript ? "Hide full transcript" : "Show full transcript"}
            </button>
            {showTranscript && (
              <ol style={{ listStyle: "none", margin: "8px 0 0", padding: 0, maxHeight: 320, overflow: "auto" }}>
                {info.transcript.map((l, i) => {
                  const missed = lapses.some((x) => l.end > x.start && l.start < x.end);
                  return (
                    <li key={i} style={{ display: "grid", gridTemplateColumns: "48px 1fr", gap: 8, padding: "4px 6px", borderLeft: `3px solid ${missed ? "var(--signal)" : "transparent"}` }}>
                      <span className="num small muted">{fmtTime(l.start)}</span>
                      <span>{l.text}{missed && <span className="sr-only"> (during a possible lapse)</span>}</span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </section>
      </div>
      <style>{`@media (max-width: 900px) { .recap-grid { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

function Flashcard({ front, back, n }: { front: string; back: string; n: number }) {
  const [flipped, setFlipped] = useState(false);
  return (
    <button className="panel" onClick={() => setFlipped((f) => !f)} aria-pressed={flipped}
      style={{ textAlign: "left", font: "inherit", color: "var(--text)", padding: 14, minHeight: 130, cursor: "pointer", display: "grid", alignContent: "space-between", gap: 10,
        background: flipped ? "var(--raised)" : "var(--surface)", borderColor: flipped ? "var(--accent)" : undefined }}>
      <span className="small muted">Card {n}, {flipped ? "answer" : "question"}</span>
      <span style={{ fontSize: 15 }}>{flipped ? back : front}</span>
      <span className="small muted">{flipped ? "Select to see the question" : "Select to see the answer"}</span>
    </button>
  );
}

// ---------------------------------------------------------------- operator

function meanOverRange(bands: BandPowerUpdate[], range: [number, number] | null): BandPowerUpdate | null {
  const rows = bands.filter((b) => b.t_video != null && (!range || (b.t_video >= range[0] && b.t_video <= range[1])));
  if (!rows.length) return null;
  const out: BandPowerUpdate["bands"] = {};
  for (const ch of Object.keys(rows[0].bands)) {
    out[ch] = Object.fromEntries(BANDS.map((b) => [b.name, rows.reduce((a, r) => a + (r.bands[ch]?.[b.name] ?? 0), 0) / rows.length])) as BandPowerUpdate["bands"][string];
  }
  return { type: "bands", bands: out };
}

function lectureSentence(lapses: Lapse[]) {
  if (!lapses.length) return "The focus estimate stayed above the lapse threshold for the whole lecture.";
  const parts = lapses.map((l) => `${fmtTime(l.start)}–${fmtTime(l.end)}`);
  return `The focus estimate dropped during ${parts.slice(0, -1).join(", ")}${parts.length > 1 ? " and " : ""}${parts.at(-1)} of the lecture.`;
}

function OperatorReview({ info, hist }: { info: RunInfo; hist: RunHistory | null }) {
  const { settings } = useSettings();
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const tl = useRef<FocusTimelineHandle>(null);
  const points = useMemo(() => toPoints(hist?.focus ?? []), [hist]);
  const duration = Math.max(info.lecture.length_s, points.at(-1)?.t ?? 0);
  const range = zoom ?? [0, duration];
  const isReplay = info.session.mode === "replay";
  const thresholds = { start: settings.rules.start_below, end: settings.rules.end_above };
  const segments = useMemo(() => {
    const out: { start: number; end: number; text: string }[] = [];
    for (const l of info.transcript) {
      const last = out.at(-1);
      if (last && l.start - last.start < 30) { last.end = l.end; } else out.push({ start: l.start, end: l.end, text: l.text });
    }
    return out;
  }, [info.transcript]);
  // webcam: stretches where the camera saw the person away (anything but "watching")
  const cameraSegments = useMemo(() => {
    const out: { start: number; end: number; text: string }[] = [];
    for (const c of hist?.camera ?? []) {
      const last = out.at(-1), text = lapseReason(`camera: ${c.state}`) ?? c.state;
      if (c.state === "watching") continue;
      if (last && last.text === text && c.t - last.end <= 1.5) last.end = c.t + 1; else out.push({ start: c.t, end: c.t + 1, text });
    }
    return out;
  }, [hist]);

  if (!hist || !hist.focus.length) {
    return (
      <div className="panel empty">
        <h2>No recorded data for this session</h2>
        <p className="muted">Review data is recorded by this browser while a session streams. Sessions run in another browser, or before a reload, only have their lapse list.</p>
      </div>
    );
  }

  const X = (t: number) => `${((t - range[0]) / (range[1] - range[0])) * 100}%`;
  const W = (a: number, b: number) => `${(Math.max(0, Math.min(b, range[1]) - Math.max(a, range[0])) / (range[1] - range[0])) * 100}%`;
  const inRange = (a: number, b: number) => b >= range[0] && a <= range[1];
  const eeg = hist.eeg;
  const name = info.lecture.title.toLowerCase().replace(/\W+/g, "-");

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section className="panel panel--primary">
        <div className="panel__head">
          <h2>Whole lecture</h2>
          <span className="small muted">{lectureSentence(hist.lapses)}</span>
          <span className="spacer" />
          <button className="btn btn--small" onClick={() => exportCsv(hist, `${name}-${info.session.run_id}.csv`, selection ?? undefined)}>
            {selection ? "Export selection as CSV" : "Export CSV"}
          </button>
          <button className="btn btn--small" onClick={() => tl.current && exportPng(tl.current.toImage(`${info.lecture.title}: focus estimate (${info.session.participant_id})`), `${name}-timeline.png`)}>Export PNG</button>
        </div>
        <div style={{ padding: "8px 12px 0" }}>
          <p className="small muted">Overview: drag to zoom{zoom ? `. Showing ${fmtTime(zoom[0])}–${fmtTime(zoom[1])}.` : "."}</p>
          <FocusTimeline points={points} duration={duration} lapses={hist.lapses} thresholds={thresholds} showTruth={isReplay}
            selection={zoom} onBrush={(r) => setZoom(r && r[1] - r[0] > 3 ? r : null)} compact height={48}
            ariaLabel="Overview of the focus estimate; drag to zoom" />
          {zoom && <button className="btn btn--quiet btn--small" onClick={() => setZoom(null)}>Show the whole lecture</button>}
        </div>
        <div style={{ padding: "8px 0 4px" }}>
          <p className="small muted" style={{ padding: "0 12px" }}>Drag on the timeline below to select a range for band power and raw EEG.</p>
          <FocusTimeline ref={tl} points={points} duration={duration} range={range} lapses={hist.lapses} markers={hist.markers}
            thresholds={thresholds} showTruth={isReplay} selection={selection}
            onBrush={(r) => setSelection(r && r[1] - r[0] > 1 ? r : null)} height={200} leftPad={110}
            ariaLabel={`Focus estimate from ${fmtTime(range[0])} to ${fmtTime(range[1])}`} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", fontSize: 13, borderTop: "1px solid var(--rule)" }}>
          {[
            { label: "Markers", items: hist.markers.filter((m) => inRange(m.t_video, m.t_video)).map((m) => ({ a: m.t_video, b: m.t_video, text: m.label, kind: "marker" })) },
            { label: "Lapses", items: hist.lapses.filter((l) => inRange(l.start, l.end)).map((l) => ({ a: l.start, b: l.end,
                text: `${fmtTime(l.start)}–${fmtTime(l.end)}${lapseReason(l.reason) ? `, ${lapseReason(l.reason)}` : ""}${l.dismissed ? ", dismissed" : ""}`, kind: "lapse" })) },
            ...(cameraSegments.length ? [{ label: "Camera", items: cameraSegments.filter((s) => inRange(s.start, s.end)).map((s) => ({ a: s.start, b: s.end, text: s.text, kind: "lapse" })) }] : []),
            { label: "Lecture", items: segments.filter((s) => inRange(s.start, s.end)).map((s) => ({ a: s.start, b: s.end, text: s.text, kind: "segment" })) },
          ].map((row) => (
            <div key={row.label} style={{ display: "contents" }}>
              <div className="muted" style={{ padding: "6px 12px", borderBottom: "1px solid var(--rule)" }}>{row.label}</div>
              <div style={{ position: "relative", height: 30, borderBottom: "1px solid var(--rule)", marginRight: 12, overflow: "hidden" }}>
                {row.items.map((it, i) => (
                  <button key={i} title={it.text} onClick={() => setSelection(it.kind === "marker" ? [Math.max(0, it.a - 5), it.a + 5] : [it.a, it.b])}
                    style={{ position: "absolute", top: 4, bottom: 4, left: X(Math.max(range[0], it.a)), width: it.kind === "marker" ? 2 : W(it.a, it.b),
                      minWidth: it.kind === "marker" ? 2 : 6, padding: it.kind === "marker" ? 0 : "0 6px", font: "inherit", fontSize: 12, textAlign: "left",
                      overflow: it.kind === "marker" ? "visible" : "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", cursor: "pointer",
                      border: it.kind === "segment" ? "1px solid var(--rule-strong)" : "none", borderRadius: 2,
                      background: it.kind === "lapse" ? "var(--signal-soft)" : it.kind === "marker" ? "var(--text)" : "var(--surface)",
                      color: it.kind === "lapse" ? "var(--text)" : "var(--text-muted)" }}>
                    {it.kind === "marker" ? <span style={{ position: "absolute", left: 5, top: 0, color: "var(--text-muted)" }}>{it.text}</span> : it.text}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 340px) minmax(0, 1fr)", gap: 16, alignItems: "start" }} className="recap-grid">
        <section className="panel">
          <div className="panel__head"><h2>{selection ? `Band power ${fmtTime(selection[0])}–${fmtTime(selection[1])}` : "Band power, whole lecture"}</h2></div>
          <div className="panel__body">
            <BandPowerPanel latest={meanOverRange(hist.bands, selection)} title="Mean over the range"
              history={hist.bands.filter((b) => !selection || (b.t_video! >= selection[0] && b.t_video! <= selection[1])).map((b) => {
                const v = Object.values(b.bands); const m = (k: "alpha" | "theta" | "beta") => v.reduce((a, r) => a + r[k], 0) / v.length;
                return m("beta") / Math.max(1e-9, m("alpha") + m("theta"));
              })} />
          </div>
        </section>
        <section className="panel">
          <div className="panel__head"><h2>Raw EEG {selection ? `${fmtTime(selection[0])}–${fmtTime(selection[1])}` : ""}</h2><span className="spacer" />
            <span className="small muted">1–40 Hz, {settings.notch} Hz notch, 50 µV per channel row</span></div>
          <div style={{ height: 280, padding: 8 }}>
            {!eeg ? <p className="muted small">No raw EEG was recorded for this session.</p>
              : !selection ? <p className="muted small" style={{ padding: 8 }}>Select a range of up to 60 s on the timeline to see the raw EEG.</p>
              : selection[1] - selection[0] > 60 ? <p className="muted small" style={{ padding: 8 }}><Icon name="warn" /> Select 60 s or less to draw raw EEG.</p>
              : <TraceViewer channels={eeg.channels} data={{ sfreq: eeg.sfreq, samples: eeg.data, t0: eeg.t0 }} range={selection} filter
                  gain={50} windowS={selection[1] - selection[0]} notch={settings.notch} ariaLabel={`Raw EEG from ${fmtTime(selection[0])} to ${fmtTime(selection[1])}`} />}
          </div>
        </section>
      </div>
    </div>
  );
}
