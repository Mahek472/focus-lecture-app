// Turns one recorded run into (1) a log of distractions with video timestamps, merging EEG lapses
// and webcam "away" episodes, and (2) attention analytics an educator or specialist can use to
// spot patterns (vigilance decline, many brief lapses, inconsistent focus, fatigue). None of
// this is a diagnosis: every observation is a pattern worth a conversation, not a label.

import type { CameraSample, RunHistory, TranscriptLine } from "../data/types";

export type DistractionSource = "eeg" | "camera";
export interface Distraction {
  start: number;            // video seconds
  end: number;
  sources: DistractionSource[];
  reasons: string[];
  snippet: string;          // what was said meanwhile
}

const CAMERA_REASON: Record<Exclude<CameraSample["state"], "watching">, string> = {
  face_missing: "Left the screen",
  head_turned: "Head turned away",
  head_down: "Looking down",
  eyes_off: "Eyes off the screen",
};

export const CAMERA_LABEL: Record<CameraSample["state"], string> = { watching: "Watching the screen", ...CAMERA_REASON };

export const snippetOf = (transcript: TranscriptLine[], a: number, b: number) =>
  transcript.filter((l) => l.end > a && l.start < b).map((l) => l.text).join(" ");

/** Runs of non-watching webcam seconds lasting at least `minS` (the backend's override also waits 3 s). */
export function cameraEpisodes(samples: CameraSample[], minS = 3) {
  const out: { start: number; end: number; reasons: string[] }[] = [];
  let cur: { start: number; end: number; reasons: Set<string> } | null = null;
  const flush = () => { if (cur && cur.end - cur.start >= minS) out.push({ start: cur.start, end: cur.end, reasons: [...cur.reasons] }); cur = null; };
  for (const s of samples) {
    if (s.state === "watching") { flush(); continue; }
    if (cur && s.t_video - cur.end > 2.5) flush();          // a gap (seek or camera hiccup) splits episodes
    cur ??= { start: s.t_video, end: s.t_video, reasons: new Set() };
    cur.end = s.t_video + 1;
    cur.reasons.add(CAMERA_REASON[s.state]);
  }
  flush();
  return out;
}

/** EEG lapses and camera episodes on one list, overlapping or near-adjacent ones (< 3 s apart) merged. */
export function distractions(hist: RunHistory, transcript: TranscriptLine[]): Distraction[] {
  const raw = [
    // a backend lapse says why it started: "eeg", or "camera: <state>" (the 3 s camera override); "I was focused" ones are left out
    ...hist.lapses.filter((l) => !l.dismissed).map((l) => {
      const cam = l.reason?.startsWith("camera") ? l.reason.replace(/^camera:\s*/, "") as Exclude<CameraSample["state"], "watching"> : null;
      return cam ? { start: l.start, end: l.end, sources: ["camera"] as DistractionSource[], reasons: [CAMERA_REASON[cam] ?? "Away from the screen"] }
                 : { start: l.start, end: l.end, sources: ["eeg"] as DistractionSource[], reasons: ["EEG focus estimate dropped"] };
    }),
    ...cameraEpisodes(hist.camera ?? []).map((e) => ({ ...e, sources: ["camera"] as DistractionSource[] })),
  ].sort((a, b) => a.start - b.start);
  const out: Distraction[] = [];
  for (const d of raw) {
    const last = out.at(-1);
    if (last && d.start - last.end < 3) {
      last.end = Math.max(last.end, d.end);
      last.sources = [...new Set([...last.sources, ...d.sources])];
      last.reasons = [...new Set([...last.reasons, ...d.reasons])];
    } else out.push({ ...d, snippet: "" });
  }
  for (const d of out) d.snippet = snippetOf(transcript, d.start, d.end);
  return out;
}

// ---------------------------------------------------------------- analytics

export interface Insights {
  watchedS: number;
  focusedFraction: number | null;
  distractedS: number;
  count: number;
  perTenMin: number | null;
  firstAt: number | null;
  meanLengthS: number | null;
  longestS: number | null;
  longestFocusedS: number;
  variability: number | null;                       // SD of the per-second focus score
  quarters: { label: string; from: number; to: number; focus: number | null; distractedS: number }[];
  vigilanceDrop: number | null;                     // first-quarter focus minus last-quarter focus
  thetaBeta: { overall: number | null; byQuarter: (number | null)[]; channels: string[] };
  camera: { seconds: number; byState: { state: CameraSample["state"]; seconds: number }[]; blinkEarly: number | null; blinkLate: number | null } | null;
  interventions: { total: number; rewind: number; focused: number; kept: number; unanswered: number };
  hardest: { start: number; end: number; distractedS: number; text: string }[];
  observations: { title: string; detail: string; tone: "note" | "flag" }[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = (xs: number[]) => { const m = mean(xs); return m == null || xs.length < 2 ? null : Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

export function computeInsights(hist: RunHistory, dist: Distraction[], duration: number, transcript: TranscriptLine[]): Insights {
  const focus = hist.focus;
  const known = focus.filter((f) => f.state !== "unknown");
  const watchedS = focus.length;
  const end = Math.max(duration, focus.at(-1)?.t_video ?? 0, 1);
  const lengths = dist.map((d) => d.end - d.start);
  const distractedS = lengths.reduce((a, b) => a + b, 0);

  let longestFocusedS = 0, run = 0, prevT = -Infinity;
  for (const f of focus) {
    run = f.state === "focused" && f.t_video - prevT <= 2 ? run + 1 : f.state === "focused" ? 1 : 0;
    longestFocusedS = Math.max(longestFocusedS, run); prevT = f.t_video;
  }

  const quarters = [0, 1, 2, 3].map((q) => {
    const from = (end * q) / 4, to = (end * (q + 1)) / 4;
    const scores = focus.filter((f) => f.t_video >= from && f.t_video < to).map((f) => f.score);
    return { label: `Q${q + 1}`, from, to, focus: mean(scores), distractedS: dist.reduce((a, d) => a + overlap(d.start, d.end, from, to), 0) };
  });
  const q1 = quarters[0].focus, q4 = quarters[3].focus;

  // theta/beta over frontal-central sites (Fz, Cz) where the ADHD literature measures it; else all channels
  const chAll = Object.keys(hist.bands[0]?.bands ?? {});
  const chTbr = chAll.filter((c) => c === "Fz" || c === "Cz").length ? chAll.filter((c) => c === "Fz" || c === "Cz") : chAll;
  const tbrAt = (from: number, to: number) => {
    const rows = hist.bands.filter((b) => b.t_video != null && b.t_video >= from && b.t_video < to);
    const vals = rows.flatMap((r) => chTbr.map((c) => r.bands[c]).filter(Boolean).map((b) => b.theta / Math.max(1e-9, b.beta)));
    return mean(vals);
  };

  let camera: Insights["camera"] = null;
  const cam = hist.camera ?? [];
  if (cam.length) {
    const states: CameraSample["state"][] = ["watching", "eyes_off", "head_turned", "head_down", "face_missing"];
    const third = cam.length / 3;
    const blinks = (xs: CameraSample[]) => mean(xs.map((x) => x.blink_rate).filter((x): x is number => x != null));
    camera = {
      seconds: cam.length,
      byState: states.map((s) => ({ state: s, seconds: cam.filter((x) => x.state === s).length })),
      blinkEarly: blinks(cam.slice(0, Math.floor(third))), blinkLate: blinks(cam.slice(Math.ceil(2 * third))),
    };
  }

  const iv = hist.interventions ?? [];
  const interventions = {
    total: iv.length, rewind: iv.filter((x) => x.choice === "rewind").length, focused: iv.filter((x) => x.choice === "focused").length,
    kept: iv.filter((x) => x.choice === "continue").length, unanswered: iv.filter((x) => !x.choice).length,
  };

  // stretches of the lecture (about 30 s each, on transcript boundaries) with the most distraction
  const segs: { start: number; end: number; text: string }[] = [];
  for (const l of transcript) {
    const last = segs.at(-1);
    if (last && l.start - last.start < 30) { last.end = l.end; last.text += ` ${l.text}`; } else segs.push({ start: l.start, end: l.end, text: l.text });
  }
  if (!segs.length) for (let a = 0; a < end; a += 30) segs.push({ start: a, end: Math.min(end, a + 30), text: "" });
  const hardest = segs.map((s) => ({ ...s, distractedS: dist.reduce((a, d) => a + overlap(d.start, d.end, s.start, s.end), 0) }))
    .filter((s) => s.distractedS >= 3).sort((a, b) => b.distractedS - a.distractedS).slice(0, 3);

  const ins: Insights = {
    watchedS,
    focusedFraction: known.length ? known.filter((f) => f.state === "focused").length / known.length : null,
    distractedS, count: dist.length,
    perTenMin: watchedS >= 60 ? dist.length / (watchedS / 600) : null,
    firstAt: dist[0]?.start ?? null,
    meanLengthS: mean(lengths), longestS: lengths.length ? Math.max(...lengths) : null,
    longestFocusedS,
    variability: sd(focus.map((f) => f.score)),
    quarters, vigilanceDrop: q1 != null && q4 != null ? q1 - q4 : null,
    thetaBeta: { overall: tbrAt(0, Infinity), byQuarter: quarters.map((q) => tbrAt(q.from, q.to)), channels: chTbr },
    camera, interventions, hardest, observations: [],
  };
  ins.observations = observe(ins);
  return ins;
}

// Plain-language patterns. Thresholds are deliberately simple and shown in the UI, so an educator
// can see why something was flagged.
function observe(i: Insights): Insights["observations"] {
  const o: Insights["observations"] = [];
  const m = (s: number) => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
  if (i.vigilanceDrop != null && i.vigilanceDrop >= 0.15)
    o.push({ tone: "flag", title: "Focus faded as the lecture went on",
      detail: `The focus estimate was ${Math.round(i.vigilanceDrop * 100)} points lower in the last quarter than the first. Shorter segments with a break or an active task in between may help.` });
  if (i.perTenMin != null && i.perTenMin >= 3 && (i.meanLengthS ?? 99) < 15)
    o.push({ tone: "flag", title: "Many short lapses",
      detail: `About ${i.perTenMin.toFixed(1)} distractions per 10 minutes, ${Math.round(i.meanLengthS!)} s each on average. Frequent brief lapses are common with attention difficulties; questions or prompts every few minutes keep re-engaging.` });
  if (i.longestS != null && i.longestS >= 45)
    o.push({ tone: "flag", title: "At least one long disengagement",
      detail: `The longest distraction lasted ${m(i.longestS)}. Content in that stretch is the most likely to have been missed entirely: review it first.` });
  if (i.variability != null && i.variability >= 0.25)
    o.push({ tone: "note", title: "Focus was inconsistent from moment to moment",
      detail: `The focus estimate swung widely (SD ${i.variability.toFixed(2)}). Highly variable attention is worth watching across sessions rather than reading into one.` });
  if (i.firstAt != null && i.firstAt < 120)
    o.push({ tone: "note", title: "Early first lapse",
      detail: `The first distraction came ${m(i.firstAt)} in. A short warm-up, or a preview of what the lecture covers, can help settle in.` });
  if (i.camera) {
    const away = i.camera.seconds - (i.camera.byState.find((s) => s.state === "watching")?.seconds ?? 0);
    if (away / i.camera.seconds >= 0.15)
      o.push({ tone: "flag", title: "Often looked away from the screen",
        detail: `The camera saw the participant away from the screen ${Math.round((away / i.camera.seconds) * 100)}% of the time. Check the room for distractions, or whether the participant needs movement breaks.` });
    const { blinkEarly: a, blinkLate: b } = i.camera;
    if (a != null && b != null && a > 0 && b / a >= 1.3)
      o.push({ tone: "note", title: "Signs of tiredness later on",
        detail: `Blink rate rose from ${Math.round(a)} to ${Math.round(b)} per minute between the first and last third, a common sign of fatigue.` });
  }
  const answered = i.interventions.total - i.interventions.unanswered;
  if (answered >= 2 && i.interventions.focused / answered >= 0.5)
    o.push({ tone: "note", title: "Often felt focused when the EEG disagreed",
      detail: `The participant answered "I was focused" to ${i.interventions.focused} of ${answered} alerts. Either the calibration needs repeating, or lapses are happening without the person noticing them; both are worth discussing.` });
  if (!o.length) o.push({ tone: "note", title: "No notable patterns", detail: "Attention stayed steady by every measure here. One session is a small sample, so compare across a few lectures." });
  return o;
}
