// One simulated run of the backend: EEG generation, a stand-in for the per-user model, band power,
// signal quality, and the contract's lapse/intervention rules. Used live by MockSource and offline
// to fabricate history for the demo sessions in the sessions list.

import { BANDS } from "../types";
import type {
  BandName, BandPowerUpdate, ChannelName, FocusState, FocusUpdate, InterventionEvent, InterventionMode, LapseEvent,
  Quality, RunMode, StatusUpdate, Truth,
} from "../types";
import { EegSimulator } from "./eegSimulator";
import { bandSum, DisplayFilter, powerSpectrum, std } from "../../lib/dsp";

export interface LapseRules {
  smoothing_s: number;   // 5
  start_below: number;   // 0.4
  start_for_s: number;   // 8
  end_above: number;     // 0.5
  end_for_s: number;     // 4
  camera_override_s: number; // 3
  intervention_after_s: number; // 10
  cooldown_s: number;    // 90
}

export const DEFAULT_RULES: LapseRules = {
  smoothing_s: 5, start_below: 0.4, start_for_s: 8, end_above: 0.5, end_for_s: 4,
  camera_override_s: 3, intervention_after_s: 10, cooldown_s: 90,
};

type Out = FocusUpdate | BandPowerUpdate | LapseEvent | InterventionEvent | StatusUpdate;

export class RunEngine {
  readonly sim: EegSimulator;
  readonly sfreq = 125;
  private filt: DisplayFilter[];
  private buf: Float32Array[];          // last 512 filtered samples per channel (quality, bands)
  private rawBuf: Float32Array[];       // last 512 raw samples (hum)
  private bufPos = 0;
  private rnd: () => number;
  private scores: number[] = [];
  private truthHist: Truth[] = [];
  private below = 0; private above = 0;
  private inLapse = false; private lapseStart = 0; private lapseSecs = 0;
  private lastIntervention = -1e9;
  private driftLeft = 0;                // live mode: seconds left in a drift episode
  private phoneLeft = 0;                // live mode: seconds the camera sees a phone
  private phoneSecs = 0;
  history: Float32Array[] = [];         // full raw EEG history (optional)
  private histLen = 0;
  keepHistory: boolean;

  constructor(
    readonly channels: ChannelName[],
    readonly mode: RunMode,
    public intervention: InterventionMode,
    public sensitivity: number,
    public rules: LapseRules = DEFAULT_RULES,
    seed = 11,
    keepHistory = true,
  ) {
    this.sim = new EegSimulator(channels, this.sfreq, seed);
    this.filt = channels.map(() => new DisplayFilter(this.sfreq, 60));
    this.buf = channels.map(() => new Float32Array(512));
    this.rawBuf = channels.map(() => new Float32Array(512));
    let s = (seed * 7919) >>> 0;
    this.rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    this.keepHistory = keepHistory;
    if (keepHistory) this.history = channels.map(() => new Float32Array(this.sfreq * 60 * 20)); // 20 min
  }

  /** Generate n raw samples; returns [channel][sample]. */
  generate(n: number): number[][] {
    const raw = this.sim.next(n);
    for (let c = 0; c < this.channels.length; c++) {
      for (let k = 0; k < n; k++) {
        const pos = (this.bufPos + k) % 512;
        this.rawBuf[c][pos] = raw[c][k];
        this.buf[c][pos] = this.filt[c].step(raw[c][k]);
        if (this.keepHistory && this.histLen + k < this.history[c].length) this.history[c][this.histLen + k] = raw[c][k];
      }
    }
    this.bufPos = (this.bufPos + n) % 512;
    this.histLen += n;
    return raw;
  }

  get historyLength() { return Math.min(this.histLen, this.history[0]?.length ?? 0); }

  private ordered(b: Float32Array) {
    const out = new Float32Array(512);
    for (let i = 0; i < 512; i++) out[i] = b[(this.bufPos + i) % 512];
    return out;
  }

  private gauss() {
    const u = Math.max(1e-9, this.rnd()), v = this.rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Ground truth at a video time. Replay: alternating 1-minute chunks, attentive first. */
  truthAt(t: number): Truth {
    if (this.mode === "replay") return Math.floor(t / 60) % 2 === 0 ? "attentive" : "distracted";
    return this.driftLeft > 0 || this.phoneLeft > 0 ? "distracted" : "attentive";
  }

  qualityNow(): Record<ChannelName, Quality> {
    const q: Record<ChannelName, Quality> = {};
    this.channels.forEach((ch, c) => {
      const sd = std(this.ordered(this.buf[c]), 512 - 250);
      q[ch] = sd < 0.5 || sd > 60 ? "bad" : sd > 30 ? "check" : "good";
    });
    return q;
  }

  bandsNow(): Record<ChannelName, Record<BandName, number>> {
    const out: Record<ChannelName, Record<BandName, number>> = {};
    this.channels.forEach((ch, c) => {
      const spec = powerSpectrum(this.ordered(this.buf[c]), this.sfreq, 256);
      out[ch] = Object.fromEntries(BANDS.map((b) => [b.name, bandSum(spec, b.lo, b.hi)])) as Record<BandName, number>;
    });
    return out;
  }

  /** Real webcam state from the UI (CameraMessage); replaces the simulated phone pick-ups while fresh. */
  externalCamera: { away: boolean; reason: string; at: number } | null = null;
  private cameraFresh() { return !!this.externalCamera && Date.now() - this.externalCamera.at < 3000; }

  camera() {
    if (this.cameraFresh()) {
      const c = this.externalCamera!;
      return { face_in_view: !c.away, override: this.phoneSecs >= this.rules.camera_override_s, reason: c.away ? c.reason : undefined };
    }
    return { face_in_view: this.phoneLeft <= 0, override: this.phoneSecs >= this.rules.camera_override_s,
             reason: this.phoneLeft > 0 ? "phone in view" : undefined };
  }

  /** One second of backend logic at video time t (call while the video plays). */
  tick(t: number): Out[] {
    const out: Out[] = [];
    if (this.cameraFresh()) {
      // contract camera override: counts seconds the webcam sees the person away
      this.phoneLeft = 0;
      this.phoneSecs = this.externalCamera!.away ? this.phoneSecs + 1 : 0;
    } else if (this.mode === "live") {
      // simulated live attention process: occasional phone pick-ups
      if (this.phoneLeft > 0) this.phoneLeft--; else if (this.rnd() < 1 / 150) this.phoneLeft = 6 + Math.floor(this.rnd() * 8);
      this.phoneSecs = this.phoneLeft > 0 ? this.phoneSecs + 1 : 0;
    }
    if (this.mode === "live") {
      if (this.driftLeft > 0) this.driftLeft--; else if (this.rnd() < 1 / 45) this.driftLeft = 12 + Math.floor(this.rnd() * 25);
    }
    const truth = this.truthAt(t);
    this.truthHist.push(truth);
    this.sim.distraction += ((truth === "distracted" ? 1 : 0) - this.sim.distraction) * 0.35;

    // stand-in for the model: lags ~3 s, AUC around 0.85, unreliable during artifacts
    const lagged = this.truthHist[Math.max(0, this.truthHist.length - 4)];
    const quality = this.qualityNow();
    const bad = Object.values(quality).filter((v) => v === "bad").length;
    let raw = (lagged === "distracted" ? 0.3 : 0.74) + 0.14 * this.gauss() + (this.sensitivity - 0.5) * -0.1;
    if (bad >= 2) raw = 0.5 + 0.3 * this.gauss();
    raw = Math.min(1, Math.max(0, raw));
    this.scores.push(raw);
    const win = this.scores.slice(-this.rules.smoothing_s);
    const score = win.reduce((a, b) => a + b, 0) / win.length;
    const spread = Math.sqrt(win.reduce((a, b) => a + (b - score) ** 2, 0) / win.length);
    const override = this.phoneSecs >= this.rules.camera_override_s;

    let state: FocusState = bad >= 3 ? "unknown" : score < this.rules.end_above ? "drifting" : "focused";
    if (override) state = "drifting";
    const confidence = Math.max(0.1, Math.min(0.95, 1 - spread * 2 - bad * 0.15));
    out.push({ type: "focus", t_video: t, score: +score.toFixed(3), state, quality,
               ...(this.mode === "replay" ? { truth } : {}), confidence: +confidence.toFixed(2) });
    out.push({ type: "bands", t_video: t, bands: this.bandsNow() });

    // lapse rules (contract)
    if (!this.inLapse) {
      this.below = score < this.rules.start_below && state !== "unknown" ? this.below + 1 : 0;
      if (this.below >= this.rules.start_for_s || override) {
        this.inLapse = true; this.lapseSecs = 0; this.above = 0;
        this.lapseStart = Math.max(0, t - (override ? this.rules.camera_override_s : this.rules.start_for_s));
        out.push({ type: "lapse_start", t_video: this.lapseStart });
      }
    } else {
      this.lapseSecs++;
      this.above = score > this.rules.end_above && !override ? this.above + 1 : 0;
      if (this.above >= this.rules.end_for_s) {
        this.inLapse = false; this.below = 0;
        out.push({ type: "lapse_end", t_video: Math.max(this.lapseStart, t - this.rules.end_for_s) });
      } else if (this.lapseSecs === this.rules.intervention_after_s && this.intervention !== "recap"
                 && t - this.lastIntervention >= this.rules.cooldown_s) {
        this.lastIntervention = t;
        out.push({ type: "intervention", action: this.intervention, t_video: t,
                   rewind_to: Math.max(0, this.lapseStart - 2) });
      }
    }
    if (t % 5 === 0) out.push({ type: "status", state: "running", mode: this.mode, sfreq: this.sfreq, camera: this.camera() });
    return out;
  }

  /** Close an open lapse at the end of the video. */
  finish(t: number): LapseEvent | null {
    if (!this.inLapse) return null;
    this.inLapse = false;
    return { type: "lapse_end", t_video: t };
  }
}
