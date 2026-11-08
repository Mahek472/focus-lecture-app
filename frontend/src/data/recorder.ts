// Records everything that streams during a run (focus, bands, lapses, raw EEG, operator markers)
// so the review screen and the exports work for any data source.

import type { DataSource, Unsubscribe } from "./DataSource";
import type { BandPowerUpdate, CameraSample, FocusUpdate, InterventionLog, InterventionResponse, Lapse, Marker, RunHistory, TranscriptLine } from "./types";
import { snippetFor } from "./mock/MockSource";

class GrowingSeries {
  data: Float32Array = new Float32Array(125 * 120);
  length = 0;
  push(values: number[]) {
    if (this.length + values.length > this.data.length) {
      const next = new Float32Array(Math.max(this.data.length * 2, this.length + values.length));
      next.set(this.data.subarray(0, this.length)); this.data = next;
    }
    this.data.set(values, this.length); this.length += values.length;
  }
  view() { return this.data.subarray(0, this.length); }
}

interface Recording {
  focus: FocusUpdate[];
  bands: BandPowerUpdate[];
  lapses: Lapse[];
  openLapse: number | null;
  markers: Marker[];
  camera: CameraSample[];        // one webcam reading per video second (a rewind replaces those seconds)
  interventions: InterventionLog[];
  eeg: GrowingSeries[];
  eegChannels: string[];
  sfreq: number;
  t0: number | null;             // video time when the first EEG sample of the video arrived
  transcript: TranscriptLine[];
}

export class RunRecorder {
  private recs = new Map<string, Recording>();
  private listeners = new Set<() => void>();
  private unsub: Unsubscribe[] = [];
  private videoT = 0;

  attach(source: DataSource, runId: string, transcript: TranscriptLine[]) {
    this.detach();
    const rec: Recording = this.recs.get(runId) ?? { focus: [], bands: [], lapses: [], openLapse: null, markers: [], camera: [], interventions: [],
      eeg: [], eegChannels: [], sfreq: 125, t0: null, transcript };
    rec.transcript = transcript;
    this.recs.set(runId, rec);
    this.unsub = [
      source.on("focus", (m) => {   // one entry per video second; a rewind replaces those seconds
        const sec = Math.round(m.t_video), last = rec.focus.at(-1);
        if (!last || sec > Math.round(last.t_video)) rec.focus.push(m);
        else { rec.focus = rec.focus.filter((x) => Math.round(x.t_video) !== sec); rec.focus.push(m); rec.focus.sort((a, b) => a.t_video - b.t_video); }
        this.notify();
      }),
      source.on("bands", (m) => { rec.bands.push({ ...m, t_video: m.t_video ?? this.videoT }); }),
      source.on("lapse_start", (m) => { rec.openLapse = m.t_video; this.notify(); }),
      source.on("lapse_end", (m) => {
        if (rec.openLapse !== null) {
          rec.lapses.push({ start: rec.openLapse, end: m.t_video, snippet: snippetFor(rec.transcript, rec.openLapse, m.t_video) });
          rec.openLapse = null; this.notify();
        }
      }),
      source.on("intervention", (m) => { rec.interventions.push({ t_video: m.t_video, action: m.action }); this.notify(); }),
      source.on("eeg", (m) => {
        if (!rec.eeg.length) { rec.eegChannels = m.channels; rec.sfreq = m.sfreq; rec.eeg = m.channels.map(() => new GrowingSeries()); }
        if (rec.t0 === null) rec.t0 = this.videoT;
        m.samples.forEach((s, c) => rec.eeg[c]?.push(s));
      }),
    ];
  }

  detach() { this.unsub.forEach((u) => u()); this.unsub = []; }
  setVideoTime(t: number) { this.videoT = t; }

  addMarker(runId: string, label: string, t_video: number): Marker | null {
    const rec = this.recs.get(runId);
    if (!rec) return null;
    const m = { id: `${Date.now()}`, t_video, label };
    rec.markers.push(m); this.notify();
    return m;
  }

  /** Webcam state for the current video second (sent to the backend too, but not echoed back). */
  recordCamera(runId: string, sample: CameraSample) {
    const rec = this.recs.get(runId);
    if (!rec) return;
    const sec = Math.round(sample.t_video);
    rec.camera = rec.camera.filter((x) => Math.round(x.t_video) !== sec);
    const i = rec.camera.findIndex((x) => x.t_video > sample.t_video);
    if (i < 0) rec.camera.push(sample); else rec.camera.splice(i, 0, sample);
  }

  /** How the participant answered the most recent unanswered intervention. */
  recordResponse(runId: string, choice: InterventionResponse["choice"], t_video: number) {
    const rec = this.recs.get(runId);
    if (!rec) return;
    const open = [...rec.interventions].reverse().find((x) => !x.choice && Math.abs(x.t_video - t_video) < 30);
    if (open) open.choice = choice; else rec.interventions.push({ t_video, action: "alert", choice });
    this.notify();
  }

  openLapse(runId: string) { return this.recs.get(runId)?.openLapse ?? null; }

  get(runId: string): RunHistory | null {
    const rec = this.recs.get(runId);
    if (!rec) return null;
    // a lapse still open when the run ended counts up to the last focus reading
    const lastT = rec.focus.at(-1)?.t_video ?? rec.openLapse;
    const lapses = rec.openLapse !== null && lastT !== null && lastT > rec.openLapse
      ? [...rec.lapses, { start: rec.openLapse, end: lastT, snippet: snippetFor(rec.transcript, rec.openLapse, lastT) }]
      : rec.lapses;
    return {
      run_id: runId, focus: rec.focus, bands: rec.bands, lapses, markers: rec.markers,
      camera: rec.camera, interventions: rec.interventions,
      eeg: rec.eeg.length ? { sfreq: rec.sfreq, channels: rec.eegChannels, data: rec.eeg.map((s) => s.view()), t0: rec.t0 ?? 0 } : undefined,
    };
  }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private notify() { this.listeners.forEach((f) => f()); }
}
