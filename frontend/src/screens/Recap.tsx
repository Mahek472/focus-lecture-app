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
import { CAMERA_LABEL, computeInsights, distractions, type Distraction, type Insights } from "../lib/insights";
import { geminiRecap, geminiStatus, type GeminiPart, type GeminiRecap } from "../lib/gemini";

const LANGUAGES = [["en", "English"], ["es", "Español"], ["fr", "Français"], ["hi", "हिन्दी"], ["zh", "中文"]] as const;

export function Recap() {
  const { runId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const view = params.get("view");
  const tab = view === "review" ? "review" : view === "insights" ? "insights" : "student";
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
          <button role="tab" aria-selected={tab === "insights"} aria-pressed={tab === "insights"} onClick={() => setParams({ view: "insights" })}>Insights</button>
          <button role="tab" aria-selected={tab === "review"} aria-pressed={tab === "review"} onClick={() => setParams({ view: "review" })}>Operator review</button>
        </div>
      </div>
      {tab === "student" ? <StudentRecap runId={runId} info={info} hist={hist} />
        : tab === "insights" ? <InsightsView info={info} hist={hist} onReview={() => setParams({ view: "review" })} />
        : <OperatorReview info={info} hist={hist} />}
    </div>
  );
}

// ---------------------------------------------------------------- student

const SOURCE_WORD: Record<Distraction["sources"][number], string> = { eeg: "EEG", camera: "Camera" };

function downloadDistractions(dist: Distraction[], name: string) {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = [["start", "end", "start_s", "end_s", "duration_s", "detected_by", "reasons", "what_was_said"].join(","),
    ...dist.map((d) => [fmtTime(d.start), fmtTime(d.end), d.start.toFixed(1), d.end.toFixed(1), (d.end - d.start).toFixed(1),
      d.sources.map((x) => SOURCE_WORD[x]).join(" + "), esc(d.reasons.join("; ")), esc(d.snippet)].join(","))];
  const url = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function StudentRecap({ runId, info, hist }: { runId: string; info: RunInfo; hist: RunHistory | null }) {
  const { source } = useSource();
  const { settings } = useSettings();
  const [lang, setLang] = useState("en");
  const [recap, setRecap] = useState<RecapData | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState(0);
  const [view, setView] = useState<"summary" | "cards">("summary");
  const [showTranscript, setShowTranscript] = useState(false);
  const [gStatus, setGStatus] = useState<{ configured: boolean; model: string } | null | undefined>(undefined);
  const [ai, setAi] = useState<GeminiRecap | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const video = useRef<VideoHandle>(null);

  useEffect(() => {
    setRecap(null); setError("");
    source.getRecap(runId, lang).then(setRecap).catch((e) => setError(e instanceof Error ? e.message : "Recap unavailable"));
  }, [source, runId, lang]);
  useEffect(() => { void geminiStatus().then(setGStatus); }, []);

  // the distraction log: EEG lapses and webcam "away" episodes, with video timestamps
  const dist = useMemo<Distraction[]>(() => {
    if (hist && (hist.lapses.length || hist.camera?.length)) return distractions(hist, info.transcript);
    return (recap?.items ?? []).map((it) => ({ start: it.lapse.start, end: it.lapse.end, sources: ["eeg"], reasons: ["EEG focus estimate dropped"], snippet: it.lapse.snippet }));
  }, [hist, recap, info.transcript]);
  const d = dist[sel];
  const item = d ? recap?.items.find((it) => it.lapse.end > d.start && it.lapse.start < d.end) : undefined;
  const aiPart = ai?.parts.find((p) => p.index === sel + 1);
  const focusedFraction = recap?.focused_fraction ?? (hist?.focus.length ? hist.focus.filter((f) => f.state === "focused").length / hist.focus.length : null);
  const totalMissed = dist.reduce((a, x) => a + x.end - x.start, 0);
  const name = `${info.lecture.title.toLowerCase().replace(/\W+/g, "-")}-${info.session.run_id}-distractions.csv`;

  const runGemini = async () => {
    setAiBusy(true); setAiError("");
    try { setAi(await geminiRecap({ title: info.lecture.title, youtube: info.lecture.youtube, language: lang, distractions: dist, focused_fraction: focusedFraction })); }
    catch (e) { setAiError(e instanceof Error ? e.message : "Gemini recap failed"); }
    finally { setAiBusy(false); }
  };
  // Only Gemini can write other languages (the backend recap is English only): picking a language
  // (re)writes the Gemini recap in it, so the switch always changes what's on screen.
  const langSeen = useRef(lang);
  useEffect(() => {
    if (langSeen.current === lang) return;
    langSeen.current = lang;
    setAi(null); setAiError("");
    if (gStatus?.configured && dist.length) void runGemini();
  }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const replay = (i: number) => { setSel(i); video.current?.seek(Math.max(0, dist[i].start - 3)); video.current?.play(); };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section className="panel panel--primary">
        <div className="panel__body" style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            {focusedFraction != null || recap ? (
              <p style={{ fontSize: 18 }}>You were focused for about <strong className="num">{pct(focusedFraction ?? 0)}</strong> of the lecture.
                {dist.length ? <> You may have missed {dist.length === 1 ? "one part" : `${dist.length} parts`} ({fmtTime(totalMissed)} in total): {dist.map((x) => `${fmtTime(x.start)}–${fmtTime(x.end)}`).join(", ")}.</> : " No distractions were flagged."}</p>
            ) : <p className="muted">{error || "Preparing your recap"}</p>}
            <p className="small muted" style={{ marginTop: 6 }}>These are estimates from your EEG and webcam, calibrated to you. A flagged part means it may be worth a second look, not that you weren't trying.</p>
            {recap?.note && <p className="small muted" style={{ marginTop: 4 }}>{recap.note}</p>}
          </div>
          <label className="field"><span>Recap language</span>
            <select value={lang} onChange={(e) => setLang(e.target.value)} disabled={aiBusy}>{LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <span className="small muted">{gStatus?.configured ? (aiBusy ? "Gemini is writing the recap…" : "The Gemini recap is written in this language.")
              : "Other languages need the Gemini recap (GEMINI_API_KEY)."}</span>
          </label>
        </div>
      </section>

      {dist.length > 0 && (
        <section className="panel" aria-labelledby="ai-h">
          <div className="panel__head"><h2 id="ai-h">Catch-up recap from Gemini</h2><span className="spacer" />
            {ai && <span className="small muted">{ai.model}, {ai.used_video ? "watched the missed clips" : "from the transcript"}</span>}
            <button className="btn btn--small btn--primary" onClick={runGemini} disabled={aiBusy || !gStatus?.configured}>
              {aiBusy ? "Writing recap…" : ai ? "Write again" : "Write my catch-up recap"}</button>
          </div>
          <div className="panel__body" style={{ display: "grid", gap: 10 }}>
            {gStatus === null && <p className="small muted">The Gemini recap needs the dev server (npm run dev); it isn't available in a static build.</p>}
            {gStatus && !gStatus.configured && (
              <div className="notice notice--info">Add <code>GEMINI_API_KEY=…</code> to <code>focus-lecture-app/frontend/.env</code> and restart <code>npm run dev</code> to get an AI summary of just the parts you missed.</div>)}
            {gStatus?.configured && !ai && !aiBusy && !aiError && (
              <p className="small muted">Gemini {info.lecture.youtube ? "watches only the clips you missed" : "reads what was said in the parts you missed"} and explains them in short, plain steps, with key terms and a quick check question for each. Nothing else about the session is sent.</p>)}
            {aiBusy && <p className="small muted">This takes 10–60 seconds{info.lecture.youtube ? " while Gemini watches the clips" : ""}.</p>}
            {aiError && <div className="notice notice--warn"><Icon name="warn" />{aiError}</div>}
            {ai && (
              <>
                <p style={{ fontSize: 15, lineHeight: 1.55 }}>{ai.overview}</p>
                {ai.study_tips.length > 0 && (
                  <div><p className="small muted">How to review</p>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18, display: "grid", gap: 4 }}>{ai.study_tips.map((t, i) => <li key={i}>{t}</li>)}</ul></div>)}
                {ai.video_error && <p className="small muted">Gemini couldn't open the video ({ai.video_error}), so this recap is from the transcript.</p>}
              </>
            )}
          </div>
        </section>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.6fr)", gap: 16, alignItems: "start" }} className="recap-grid">
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16, minWidth: 0 }}>
          <section className="panel" aria-labelledby="lapses-h">
            <div className="panel__head"><h2 id="lapses-h">When you were distracted</h2><span className="spacer" />
              {dist.length > 0 && <button className="btn btn--small btn--quiet" onClick={() => downloadDistractions(dist, name)}>Download timestamps</button>}</div>
            {dist.length === 0 ? <p className="panel__body muted">{recap || hist ? "Nothing to review." : "Loading"}</p> : (
              <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {dist.map((x, i) => (
                  <li key={i} style={{ borderBottom: "1px solid var(--rule)", borderLeft: `3px solid ${i === sel ? "var(--accent)" : "transparent"}`, background: i === sel ? "var(--accent-soft)" : undefined }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px" }}>
                      <button className="btn btn--quiet" style={{ flex: 1, minWidth: 0, justifyContent: "flex-start", padding: 0, display: "grid", textAlign: "left", gap: 2 }} onClick={() => setSel(i)} aria-pressed={i === sel}>
                        <span><span className="num" style={{ fontWeight: 500 }}>{fmtTime(x.start)}–{fmtTime(x.end)}</span>
                          <span className="small muted num"> · {Math.round(x.end - x.start)} s · {x.sources.map((k) => SOURCE_WORD[k]).join(" + ")}</span></span>
                        <span className="small muted" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {ai?.parts.find((p) => p.index === i + 1)?.title ?? x.reasons.join(", ")}</span>
                      </button>
                      <button className="btn btn--small" onClick={() => replay(i)}>Replay</button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section className="panel" aria-label="Lecture video">
            <VideoPlayer ref={video} src={info.lecture.video || undefined} youtube={info.lecture.youtube} length_s={info.lecture.length_s}
              title={info.lecture.title} transcript={info.transcript} captions={settings.captions} onState={() => {}} forceSim={forceSimVideo()} />
          </section>
        </div>

        <section className="panel" aria-labelledby="recap-h">
          <div className="panel__head">
            <h2 id="recap-h">{d ? (aiPart ? aiPart.title : `What was said ${fmtTime(d.start)}–${fmtTime(d.end)}`) : "Recap"}</h2>
            <span className="spacer" />
            {(aiPart || item) && (
              <div className="segmented" role="tablist" aria-label="Recap format">
                <button role="tab" aria-selected={view === "summary"} aria-pressed={view === "summary"} onClick={() => setView("summary")}>Summary</button>
                <button role="tab" aria-selected={view === "cards"} aria-pressed={view === "cards"} onClick={() => setView("cards")}>Flashcards</button>
              </div>)}
          </div>
          <div className="panel__body" style={{ minHeight: 200, display: "grid", gap: 12, alignContent: "start" }}>
            {d && <p className="small muted">{fmtTime(d.start)}–{fmtTime(d.end)} · {d.reasons.join(", ")}</p>}
            {!d ? <p className="muted">Select a part on the left.</p> : aiPart ? (
              <>
                <p className="small"><span className={`status status--${aiPart.importance === "core" ? "warn" : "neutral"}`}>
                  {aiPart.importance === "core" ? "Core idea: later parts build on this" : aiPart.importance === "supporting" ? "Supporting detail" : "Aside"}</span></p>
                {view === "summary" ? (
                  <>
                    <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8, fontSize: 15, lineHeight: 1.55 }}>{aiPart.summary.map((x, i) => <li key={i}>{x}</li>)}</ul>
                    {aiPart.key_terms.length > 0 && (
                      <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 12px" }}>
                        {aiPart.key_terms.map((k, i) => <div key={i} style={{ display: "contents" }}><dt style={{ fontWeight: 600 }}>{k.term}</dt><dd style={{ margin: 0 }}>{k.meaning}</dd></div>)}
                      </dl>)}
                  </>
                ) : (
                  // Gemini's cards for this part: its flashcards, the check question, and one per key term
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
                    {aiCards(aiPart).map((c, i) => <Flashcard key={`ai-${sel}-${i}`} front={c.front} back={c.back} n={i + 1} />)}
                  </div>
                )}
              </>
            ) : !item ? (
              <p className="muted">{d.snippet ? `“${d.snippet}”` : "No transcript for this part."} {gStatus?.configured ? "Write the Gemini recap above for a summary." : ""}</p>
            ) : view === "summary" ? (
              <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8, fontSize: 15, lineHeight: 1.55 }}>
                {item.summary.map((x, i) => <li key={i}>{x}</li>)}
              </ul>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
                {item.flashcards.map((c, i) => <Flashcard key={`${sel}-${i}`} front={c.front} back={c.back} n={i + 1} />)}
                {item.flashcards.length === 0 && <p className="muted">No flashcards for this part.</p>}
              </div>
            )}
          </div>
          <div style={{ borderTop: "1px solid var(--rule)", padding: "8px 12px" }}>
            <button className="btn btn--quiet btn--small" aria-expanded={showTranscript} onClick={() => setShowTranscript((x) => !x)}>
              {showTranscript ? "Hide full transcript" : "Show full transcript"}
            </button>
            {showTranscript && (
              <ol style={{ listStyle: "none", margin: "8px 0 0", padding: 0, maxHeight: 320, overflow: "auto" }}>
                {info.transcript.map((l, i) => {
                  const missed = dist.some((x) => l.end > x.start && l.start < x.end);
                  return (
                    <li key={i} style={{ display: "grid", gridTemplateColumns: "48px 1fr", gap: 8, padding: "4px 6px", borderLeft: `3px solid ${missed ? "var(--signal)" : "transparent"}` }}>
                      <span className="num small muted">{fmtTime(l.start)}</span>
                      <span>{l.text}{missed && <span className="sr-only"> (during a possible distraction)</span>}</span>
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

// ---------------------------------------------------------------- insights

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ padding: "10px 12px", borderLeft: "3px solid var(--rule)" }}>
      <div className="small muted">{label}</div>
      <div className="num" style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.3 }}>{value}</div>
      {hint && <div className="small muted">{hint}</div>}
    </div>
  );
}

/** Single-series column chart: one bar per lecture quarter, value labelled, hover tooltip. */
function QuarterBars({ values, fmt, label, max }: { values: { label: string; v: number | null; tip: string }[]; fmt: (v: number) => string; label: string; max: number }) {
  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="small muted" style={{ marginBottom: 6 }}>{label}</figcaption>
      <div role="list" style={{ display: "grid", gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))`, gap: 2, alignItems: "end", height: 120, borderBottom: "1px solid var(--rule-strong)" }}>
        {values.map((x) => (
          <div key={x.label} role="listitem" title={x.tip} aria-label={`${x.label}: ${x.v == null ? "no data" : fmt(x.v)}`}
            style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", gap: 2, padding: "0 10%" }}>
            <span className="small num">{x.v == null ? "–" : fmt(x.v)}</span>
            <div style={{ width: "100%", maxWidth: 48, height: `${x.v == null ? 0 : Math.max(2, (x.v / max) * 88)}%`, background: "var(--accent)", borderRadius: "4px 4px 0 0" }} />
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))`, gap: 2 }}>
        {values.map((x) => <span key={x.label} className="small muted" style={{ textAlign: "center" }}>{x.label}</span>)}
      </div>
    </figure>
  );
}

function InsightsView({ info, hist, onReview }: { info: RunInfo; hist: RunHistory | null; onReview: () => void }) {
  const dist = useMemo(() => (hist ? distractions(hist, info.transcript) : []), [hist, info.transcript]);
  const ins = useMemo<Insights | null>(() => (hist && hist.focus.length ? computeInsights(hist, dist, info.lecture.length_s, info.transcript) : null), [hist, dist, info]);

  if (!ins) {
    return (
      <div className="panel empty">
        <h2>No recorded data for this session</h2>
        <p className="muted">Insights are computed from the focus, band power and webcam data this browser records while a session streams.</p>
      </div>
    );
  }
  const m = (s: number | null) => (s == null ? "–" : s >= 90 ? `${(s / 60).toFixed(1)} min` : `${Math.round(s)} s`);
  const q = ins.quarters;
  const tbr = ins.thetaBeta;
  const tbrMax = Math.max(...tbr.byQuarter.map((v) => v ?? 0), 0.01);
  const answered = ins.interventions.total - ins.interventions.unanswered;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="notice notice--info" style={{ display: "block" }}>
        <strong>Patterns to discuss, not a diagnosis.</strong> These measures come from one session with a consumer EEG headset and a webcam.
        They can help a teacher, parent or specialist see <em>how</em> attention moved during a lecture, and are most useful compared across several sessions.
      </div>

      <section className="panel panel--primary" aria-labelledby="ins-sum">
        <div className="panel__head"><h2 id="ins-sum">Attention at a glance</h2><span className="spacer" />
          <button className="btn btn--small btn--quiet" onClick={onReview}>Open the full timeline</button></div>
        <div className="panel__body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
          <Stat label="Focused" value={ins.focusedFraction == null ? "–" : pct(ins.focusedFraction)} hint={`of ${m(ins.watchedS)} watched`} />
          <Stat label="Distractions" value={String(ins.count)} hint={ins.perTenMin == null ? undefined : `${ins.perTenMin.toFixed(1)} per 10 min`} />
          <Stat label="Time distracted" value={m(ins.distractedS)} hint={ins.meanLengthS == null ? undefined : `${Math.round(ins.meanLengthS)} s on average`} />
          <Stat label="First distraction" value={ins.firstAt == null ? "None" : fmtTime(ins.firstAt)} hint="into the video" />
          <Stat label="Longest focused stretch" value={m(ins.longestFocusedS)} />
          <Stat label="Longest distraction" value={m(ins.longestS)} />
          <Stat label="Focus variability" value={ins.variability == null ? "–" : ins.variability.toFixed(2)} hint="SD of the focus score (0–1)" />
        </div>
      </section>

      <section className="panel" aria-labelledby="ins-obs">
        <div className="panel__head"><h2 id="ins-obs">What stands out</h2></div>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {ins.observations.map((o, i) => (
            <li key={i} style={{ padding: "10px 12px", borderBottom: "1px solid var(--rule)", borderLeft: `3px solid ${o.tone === "flag" ? "var(--signal)" : "var(--rule-strong)"}` }}>
              <p style={{ fontWeight: 600, display: "flex", gap: 6, alignItems: "center" }}>{o.tone === "flag" && <span className="status status--warn"><Icon name="warn" /></span>}{o.title}</p>
              <p className="muted" style={{ marginTop: 2 }}>{o.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, alignItems: "start" }}>
        <section className="panel" aria-labelledby="ins-q">
          <div className="panel__head"><h2 id="ins-q">Focus across the lecture</h2><span className="spacer" />
            <span className="small muted">{ins.vigilanceDrop == null ? "" : ins.vigilanceDrop > 0.05 ? `Down ${Math.round(ins.vigilanceDrop * 100)} pts first to last` : ins.vigilanceDrop < -0.05 ? `Up ${Math.round(-ins.vigilanceDrop * 100)} pts first to last` : "Steady"}</span></div>
          <div className="panel__body" style={{ display: "grid", gap: 16 }}>
            <QuarterBars label="Mean focus score by quarter of the lecture" max={1} fmt={(v) => pct(v)}
              values={q.map((x) => ({ label: x.label, v: x.focus, tip: `${fmtTime(x.from)}–${fmtTime(x.to)}: mean focus ${x.focus == null ? "no data" : pct(x.focus)}` }))} />
            <QuarterBars label="Seconds distracted by quarter" max={Math.max(...q.map((x) => x.distractedS), 1)} fmt={(v) => `${Math.round(v)} s`}
              values={q.map((x) => ({ label: x.label, v: x.distractedS, tip: `${fmtTime(x.from)}–${fmtTime(x.to)}: ${Math.round(x.distractedS)} s distracted` }))} />
          </div>
        </section>

        <section className="panel" aria-labelledby="ins-tbr">
          <div className="panel__head"><h2 id="ins-tbr">Theta/beta ratio</h2><span className="spacer" />
            <span className="small muted">{tbr.channels.join(", ") || "no band data"}</span></div>
          <div className="panel__body" style={{ display: "grid", gap: 12 }}>
            {tbr.overall == null ? <p className="muted small">No band power was recorded for this session.</p> : (
              <>
                <Stat label="Whole lecture" value={tbr.overall.toFixed(2)} />
                <QuarterBars label="Theta/beta ratio by quarter" max={tbrMax} fmt={(v) => v.toFixed(2)}
                  values={q.map((x, i) => ({ label: x.label, v: tbr.byQuarter[i], tip: `${fmtTime(x.from)}–${fmtTime(x.to)}: TBR ${tbr.byQuarter[i]?.toFixed(2) ?? "no data"}` }))} />
                <p className="small muted">Higher theta relative to beta over frontal sites has been studied as a marker of under-arousal and is debated as an ADHD marker. Compare it within one person across sessions; absolute values depend on the headset and contact.</p>
              </>
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="ins-cam">
          <div className="panel__head"><h2 id="ins-cam">Webcam</h2></div>
          <div className="panel__body">
            {!ins.camera ? <p className="muted small">The camera wasn't on during this session. Turn it on in Device setup to record looking away, head position and blink rate.</p> : (
              <>
                <table className="table" style={{ fontSize: 13 }}>
                  <thead><tr><th>State</th><th className="r">Time</th><th className="r">Share</th></tr></thead>
                  <tbody>{ins.camera.byState.filter((s) => s.seconds > 0 || s.state === "watching").map((s) => (
                    <tr key={s.state}><td>{CAMERA_LABEL[s.state]}</td><td className="r num">{m(s.seconds)}</td><td className="r num">{pct(s.seconds / ins.camera!.seconds)}</td></tr>))}
                  </tbody>
                </table>
                <p className="small muted" style={{ marginTop: 8 }}>Blink rate: {ins.camera.blinkEarly == null ? "–" : Math.round(ins.camera.blinkEarly)} per minute in the first third, {ins.camera.blinkLate == null ? "–" : Math.round(ins.camera.blinkLate)} in the last. A rising rate is a common sign of tiredness.</p>
              </>
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="ins-iv">
          <div className="panel__head"><h2 id="ins-iv">Alerts and self-report</h2></div>
          <div className="panel__body">
            {ins.interventions.total === 0 ? <p className="muted small">No alerts were shown in this session (intervention mode, or no lapses).</p> : (
              <>
                <table className="table" style={{ fontSize: 13 }}>
                  <tbody>
                    <tr><td>Alerts shown</td><td className="r num">{ins.interventions.total}</td></tr>
                    <tr><td>Chose to rewind</td><td className="r num">{ins.interventions.rewind}</td></tr>
                    <tr><td>Said "I was focused"</td><td className="r num">{ins.interventions.focused}</td></tr>
                    <tr><td>Kept going</td><td className="r num">{ins.interventions.kept}</td></tr>
                    <tr><td>Not answered</td><td className="r num">{ins.interventions.unanswered}</td></tr>
                  </tbody>
                </table>
                {answered > 0 && <p className="small muted" style={{ marginTop: 8 }}>Agreement with the EEG: the participant accepted {answered - ins.interventions.focused} of {answered} alerts. Low agreement can mean the model needs recalibrating, or that lapses go unnoticed by the person.</p>}
              </>
            )}
          </div>
        </section>
      </div>

      <section className="panel" aria-labelledby="ins-hard">
        <div className="panel__head"><h2 id="ins-hard">Hardest stretches of the lecture</h2><span className="spacer" />
          <span className="small muted">Most time distracted, about 30 s each</span></div>
        {ins.hardest.length === 0 ? <p className="panel__body muted small">No stretch had more than a few seconds of distraction.</p> : (
          <table className="table" style={{ fontSize: 13 }}>
            <thead><tr><th>When</th><th className="r">Distracted</th><th>What was being taught</th></tr></thead>
            <tbody>{ins.hardest.map((h, i) => (
              <tr key={i}><td className="num" style={{ whiteSpace: "nowrap" }}>{fmtTime(h.start)}–{fmtTime(h.end)}</td><td className="r num">{Math.round(h.distractedS)} s</td>
                <td>{h.text || <span className="muted">No transcript</span>}</td></tr>))}
            </tbody>
          </table>
        )}
        <p className="small muted" style={{ padding: "8px 12px" }}>If the same kind of content shows up here across sessions (dense definitions, long derivations, fast speech), that is a useful pointer for accommodations: slides in advance, captions, or pausing for a summary.</p>
      </section>
    </div>
  );
}

function aiCards(p: GeminiPart) {
  const cards = [...(p.flashcards ?? []).map((c) => ({ front: c.question, back: c.answer })),
    { front: p.check_question.question, back: p.check_question.answer },
    ...p.key_terms.map((k) => ({ front: `What does "${k.term}" mean?`, back: k.meaning }))];
  const seen = new Set<string>();
  return cards.filter((c) => { const k = c.front.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
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
      if (last && last.text === text && c.t_video - last.end <= 1.5) last.end = c.t_video + 1; else out.push({ start: c.t_video, end: c.t_video + 1, text });
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
