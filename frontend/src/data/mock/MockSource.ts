import type { DataSource, MessageOf, SimulatedAction, Unsubscribe } from "../DataSource";
import type {
  ChannelName, ClientMessage, ConnectionState, FocusUpdate, Lapse, Lecture, Participant, Recap, RecapItem, RunHistory,
  SerialPortInfo, ServerMessage, SessionSummary, SignalCheckUpdate, StartSessionRequest, TranscriptLine,
} from "../types";
import { LECTURES, PARTICIPANTS, PAST_SESSIONS, transcriptFor } from "./content";
import { DEFAULT_RULES, RunEngine, type LapseRules } from "./runEngine";
import { EegSimulator } from "./eegSimulator";
import { bandSum, DisplayFilter, powerSpectrum, std } from "../../lib/dsp";

interface MockRun { req: StartSessionRequest; engine: RunEngine; started: string }

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Builds recap items from lapses + transcript (the real backend uses an LLM for this). */
export function mockRecap(runId: string, lapses: Lapse[], focus: FocusUpdate[], language: string): Recap {
  const known = focus.filter((f) => f.state !== "unknown");
  const focused = known.length ? known.filter((f) => f.state === "focused").length / known.length : 0;
  const items: RecapItem[] = lapses.map((lapse) => {
    const lines = lapse.snippet.split(/(?<=\.)\s+/).filter(Boolean);
    return {
      lapse,
      summary: lines.length ? lines : ["Nothing was said during this stretch."],
      flashcards: lines.slice(0, 3).map((line) => {
        const words = line.replace(/[.,]/g, "").split(" ");
        const key = [...words].sort((a, b) => b.length - a.length)[0] ?? "";
        return { front: line.replace(key, "_____"), back: `${key}. ${line}` };
      }),
    };
  });
  return {
    run_id: runId, focused_fraction: focused, items, language,
    note: language === "en" ? "Mock recap built from placeholder transcript lines."
      : "Mock data has English only. The backend's LLM writes the recap in the chosen language.",
  };
}

export function snippetFor(transcript: TranscriptLine[], start: number, end: number) {
  return transcript.filter((l) => l.end > start && l.start < end).map((l) => l.text).join(" ");
}

export class MockSource implements DataSource {
  readonly kind = "mock" as const;
  channels: ChannelName[];
  rules: LapseRules = DEFAULT_RULES;
  blockSeconds = 60;                     // calibration block length (Settings can shorten it for demos)
  hum = false;
  private handlers = new Map<string, Set<(m: never) => void>>();
  private connHandlers = new Set<(s: ConnectionState) => void>();
  private runs = new Map<string, MockRun>();
  private participants: Participant[] = PARTICIPANTS.map((p) => ({ ...p }));
  private sessions: SessionSummary[] = PAST_SESSIONS.map((s) => ({ ...s }));
  private active: MockRun | null = null;
  private activeId = "";
  private eegTimer = 0; private secTimer = 0; private calTimer = 0;
  private video = { t: 0, playing: false };
  private lastTick = -1;
  private lapses = new Map<string, Lapse[]>();
  private focusLog = new Map<string, FocusUpdate[]>();
  private openLapse: number | null = null;
  private checkSim: EegSimulator | null = null;

  constructor(channels: ChannelName[]) { this.channels = channels; }

  // ---------------------------------------------------------------- REST
  async listLectures(): Promise<Lecture[]> { await delay(120); return LECTURES; }
  async getTranscript(lectureId: string) { await delay(80); return transcriptFor(lectureId); }
  async listSessions() { await delay(150); return [...this.sessions].sort((a, b) => b.date.localeCompare(a.date)); }

  async startSession(req: StartSessionRequest) {
    await delay(200);
    const run_id = `run-${Date.now().toString(36)}`;
    const engine = new RunEngine(this.channels, req.mode, req.intervention, req.sensitivity, this.rules, Date.now() % 1000);
    engine.sim.hum = this.hum;
    this.runs.set(run_id, { req, engine, started: new Date().toISOString() });
    const lec = LECTURES.find((l) => l.id === req.lecture_id);
    this.sessions.push({ run_id, lecture_id: req.lecture_id, lecture_title: lec?.title ?? req.lecture_id,
      participant_id: req.participant_id, date: new Date().toISOString(), duration_s: 0, mode: req.mode, status: "recording" });
    return { run_id };
  }

  async startCalibration(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new Error("unknown run");
    clearInterval(this.calTimer);
    const plan = [...Array(10)].map((_, i) => ({ phase: i < 6 ? "calibration" : "test", task: i % 2 ? "count" : "watch" }) as const);
    let block = 0, left = this.blockSeconds;
    const primes = [811, 853, 877, 907, 937, 967, 983, 991, 997, 919];
    this.emit({ type: "status", state: "calibrating", mode: run.req.mode });
    this.calTimer = window.setInterval(() => {
      const b = plan[block];
      run.engine.sim.distraction += ((b.task === "count" ? 1 : 0) - run.engine.sim.distraction) * 0.3;
      this.emit({ type: "calibration", block: block + 1, n_blocks: plan.length, phase: b.phase, task: b.task,
        seconds_left: left, block_s: this.blockSeconds, ...(b.task === "count" ? { start_number: primes[block] } : {}) });
      left--;
      if (left <= 0) {
        block++; left = this.blockSeconds;
        if (block >= plan.length) {
          clearInterval(this.calTimer);
          const auc = +(0.78 + Math.random() * 0.12).toFixed(3);
          this.emit({ type: "calibration", block: plan.length, n_blocks: plan.length, phase: "test", task: "watch",
            seconds_left: 0, block_s: this.blockSeconds, done: true, auc });
          this.emit({ type: "status", state: "ready", mode: run.req.mode });
          const p = this.participants.find((x) => x.id === run.req.participant_id);
          if (p) { p.calibration_auc = auc; p.calibration_date = new Date().toISOString().slice(0, 10); }
        }
      }
    }, 1000);
  }

  async getLapses(runId: string) {
    await delay(100);
    if (this.lapses.has(runId)) return this.lapses.get(runId)!;
    return (await this.getRunHistory(runId))?.lapses ?? [];
  }

  async getRecap(runId: string, language: string) {
    await delay(300);
    const hist = await this.getRunHistory(runId);
    return mockRecap(runId, hist?.lapses ?? [], hist?.focus ?? [], language);
  }

  async stopRun(runId: string) {
    await delay(100);
    const run = this.runs.get(runId);
    if (run) {
      const end = run.engine.finish(this.video.t);
      if (end) this.handle(runId, end);
      const s = this.sessions.find((x) => x.run_id === runId);
      if (s) { s.status = "complete"; s.duration_s = Math.round(this.video.t);
        const f = this.focusLog.get(runId) ?? []; const k = f.filter((x) => x.state !== "unknown");
        s.focused_fraction = k.length ? k.filter((x) => x.state === "focused").length / k.length : undefined; }
    }
    this.emit({ type: "status", state: "stopped" });
    this.stopStreams();
  }

  async listParticipants() { await delay(80); return this.participants.map((p) => ({ ...p })); }
  async saveParticipant(p: Participant) {
    const i = this.participants.findIndex((x) => x.id === p.id);
    if (i >= 0) this.participants[i] = { ...p }; else this.participants.push({ ...p });
  }

  /** Demo sessions get a fabricated history by running the engine offline. */
  async getRunHistory(runId: string): Promise<RunHistory | null> {
    const run = this.runs.get(runId);
    if (run) return this.historyFromEngine(runId, run.engine, this.focusLog.get(runId) ?? [], this.lapses.get(runId) ?? []);
    const s = this.sessions.find((x) => x.run_id === runId);
    if (!s || s.status === "scheduled") return null;
    const engine = new RunEngine(this.channels, s.mode, "alert", 0.5, this.rules, runId.length * 31);
    const transcript = transcriptFor(s.lecture_id);
    const focus: FocusUpdate[] = []; const bands: RunHistory["bands"] = []; const lapses: Lapse[] = [];
    let open: number | null = null;
    for (let t = 0; t < s.duration_s; t++) {
      engine.generate(engine.sfreq);
      for (const m of engine.tick(t)) {
        if (m.type === "focus") focus.push(m);
        else if (m.type === "bands") bands.push(m);
        else if (m.type === "lapse_start") open = m.t_video;
        else if (m.type === "lapse_end" && open !== null) { lapses.push({ start: open, end: m.t_video, snippet: snippetFor(transcript, open, m.t_video) }); open = null; }
      }
    }
    if (open !== null) lapses.push({ start: open, end: s.duration_s, snippet: snippetFor(transcript, open, s.duration_s) });
    const markers = [
      { id: "m1", t_video: Math.round(s.duration_s * 0.3), label: "Slide change" },
      { id: "m2", t_video: Math.round(s.duration_s * 0.62), label: "Question asked" },
    ];
    return { ...this.historyFromEngine(runId, engine, focus, lapses), bands, markers };
  }

  private historyFromEngine(runId: string, engine: RunEngine, focus: FocusUpdate[], lapses: Lapse[]): RunHistory {
    const n = engine.historyLength;
    return { run_id: runId, focus, bands: [], lapses, markers: [],
      eeg: { sfreq: engine.sfreq, channels: this.channels, data: engine.history.map((h) => h.subarray(0, n)), t0: 0 } };
  }

  // ---------------------------------------------------------------- WebSocket
  connect(runId: string) {
    this.disconnect();
    const run = this.runs.get(runId);
    this.activeId = runId;
    this.active = run ?? null;
    this.setConn("connecting");
    window.setTimeout(() => {
      this.setConn("open");
      this.emit({ type: "status", state: run ? "ready" : "error", mode: run?.req.mode, sfreq: 125,
        message: run ? undefined : "Unknown run" });
      if (!run) return;
      this.video = { t: 0, playing: false }; this.lastTick = -1; this.openLapse = null;
      const fs = run.engine.sfreq, chunk = 5;           // 25 chunks/s
      this.eegTimer = window.setInterval(() => {
        run.engine.sim.hum = this.hum;
        const raw = run.engine.generate(chunk);
        this.emit({ type: "eeg", sfreq: fs, channels: this.channels, samples: raw });
      }, (1000 * chunk) / fs);
      this.secTimer = window.setInterval(() => {
        if (!this.video.playing) return;
        const t = Math.floor(this.video.t);
        if (t === this.lastTick) return;
        this.lastTick = t;
        for (const m of run.engine.tick(t)) this.handle(runId, m);
      }, 250);
    }, 300);
  }

  private handle(runId: string, m: ServerMessage) {
    if (m.type === "focus") { const l = this.focusLog.get(runId) ?? []; l.push(m); this.focusLog.set(runId, l); }
    if (m.type === "lapse_start") this.openLapse = m.t_video;
    if (m.type === "lapse_end" && this.openLapse !== null) {
      const run = this.runs.get(runId);
      const transcript = transcriptFor(run?.req.lecture_id ?? "stim2");
      const l = this.lapses.get(runId) ?? [];
      l.push({ start: this.openLapse, end: m.t_video, snippet: snippetFor(transcript, this.openLapse, m.t_video) });
      this.lapses.set(runId, l); this.openLapse = null;
    }
    this.emit(m);
  }

  private stopStreams() { clearInterval(this.eegTimer); clearInterval(this.secTimer); clearInterval(this.calTimer); }

  disconnect() {
    this.stopStreams();
    if (this.active) this.setConn("closed");
    this.active = null; this.activeId = "";
  }

  on<T extends ServerMessage["type"]>(type: T, handler: (msg: MessageOf<T>) => void): Unsubscribe {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler as (m: never) => void);
    this.handlers.set(type, set);
    return () => set.delete(handler as (m: never) => void);
  }

  onConnection(handler: (s: ConnectionState) => void) { this.connHandlers.add(handler); return () => this.connHandlers.delete(handler); }
  private setConn(s: ConnectionState) { this.connHandlers.forEach((h) => h(s)); }
  private emit(m: ServerMessage) { this.handlers.get(m.type)?.forEach((h) => (h as (x: ServerMessage) => void)(m)); }

  send(msg: ClientMessage) {
    const run = this.active;
    if (msg.type === "video_state") this.video = { t: msg.t_video, playing: msg.playing };
    if (msg.type === "settings" && run) { run.engine.intervention = msg.intervention; run.engine.sensitivity = msg.sensitivity; }
    // intervention_response and feedback are acknowledged silently, as the backend would log them
    void this.activeId;
  }

  // ---------------------------------------------------------------- device setup
  async listPorts(): Promise<SerialPortInfo[]> {
    await delay(150);
    return [
      { port: "COM3", description: "Standard Serial over Bluetooth link" },
      { port: "COM4", description: "Standard Serial over Bluetooth link" },
      { port: "COM7", description: "USB Serial Port" },
    ];
  }

  startSignalCheck(port: string, _routeRld: boolean, handler: (u: SignalCheckUpdate) => void): Unsubscribe {
    if (!port.toUpperCase().startsWith("COM7")) {
      handler({ ready: false });
      const id = window.setInterval(() => handler({ ready: false }), 1000);
      return () => clearInterval(id);
    }
    const fs = 125, n = this.channels.length;
    const sim = new EegSimulator(this.channels, fs, 3);
    sim.autoArtifacts = false;
    sim.hum = this.hum;
    sim.setFault(Math.max(0, this.channels.indexOf("P7")), "noisy");   // one electrode needs adjusting
    this.checkSim = sim;
    const filt = this.channels.map(() => new DisplayFilter(fs, 60));
    const len = fs * 10;
    const raw = this.channels.map(() => new Float32Array(len));
    const flt = this.channels.map(() => new Float32Array(len));
    let filled = 0;
    const id = window.setInterval(() => {
      const chunk = sim.next(Math.round(fs / 4));
      for (let c = 0; c < n; c++) {
        raw[c].copyWithin(0, chunk[c].length); flt[c].copyWithin(0, chunk[c].length);
        for (let k = 0; k < chunk[c].length; k++) {
          raw[c][len - chunk[c].length + k] = chunk[c][k];
          flt[c][len - chunk[c].length + k] = filt[c].step(chunk[c][k]);
        }
      }
      filled += chunk[0].length;
      if (filled < fs * 3) { handler({ ready: false }); return; }
      const show = fs * 5, stat = fs * 2;
      handler({
        ready: true, sfreq: fs,
        traces: flt.map((x) => Array.from(x.subarray(len - show)).filter((_, i) => i % 2 === 0).map((v) => +v.toFixed(1))),
        sd: flt.map((x) => +std(x.subarray(len - stat)).toFixed(1)),
        ptp: flt.map((x) => { const s = x.subarray(len - stat); return Math.round(Math.max(...s) - Math.min(...s)); }),
        hum: raw.map((x) => { const sp = powerSpectrum(x, fs, 512); return +(bandSum(sp, 58, 62) / (bandSum(sp, 1, 40) + 1e-9)).toFixed(2); }),
        alpha: flt.map((x) => { const sp = powerSpectrum(x, fs, 512); return +(bandSum(sp, 8, 12) / (bandSum(sp, 1, 40) + 1e-9)).toFixed(2); }),
        dc: raw.map((x) => Math.round(x.subarray(len - stat).reduce((a, b) => a + b, 0) / stat)),
      });
    }, 250);
    return () => { clearInterval(id); this.checkSim = null; };
  }

  simulate(action: SimulatedAction) {
    const sims = [this.checkSim, this.active?.engine.sim].filter(Boolean) as EegSimulator[];
    for (const s of sims) {
      if (action === "blink") s.blink();
      if (action === "clench") s.clench();
      if (action === "eyes_closed") s.eyesClosed = true;
      if (action === "eyes_open") s.eyesClosed = false;
      if (action === "fix_contact") this.channels.forEach((_, c) => s.setFault(c, "ok"));
    }
  }
}
