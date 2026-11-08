// Realistic-looking 8-channel EEG for the mock: pink noise (5-30 uV), posterior alpha bursts that
// grow with distraction (as in BBBD) and with eyes closed, Fp1 blinks, jaw-clench EMG, movement
// drifts, one flaky channel and optional 60 Hz hum. Values are raw uV before display filtering.

import type { ChannelName } from "../types";

const POSTERIOR = new Set(["P3", "P4", "P7", "P8", "Pz", "O1", "O2", "Oz", "POz"]);

class Pink {
  // ~1/f background at 125 Hz from three AR(1) stages (tuned: 1-30 Hz shares about
  // delta 48%, theta 23%, alpha 12%, beta 17% before the alpha rhythm is added).
  private s = [0, 0, 0];
  private static P = [0.99, 0.9, 0.6];
  private static W = [1, 0.6, 0.35];
  next(white: number) {
    let y = 0;
    for (let i = 0; i < 3; i++) {
      const p = Pink.P[i];
      this.s[i] = p * this.s[i] + Math.sqrt(1 - p * p) * white;
      y += Pink.W[i] * this.s[i];
    }
    return y;
  }
}

export type ChannelFault = "ok" | "noisy" | "flat";

export class EegSimulator {
  readonly sfreq: number;
  private t = 0;                       // sample counter
  private pink: Pink[];
  private alphaPhase: number[];
  private alphaEnv: number[];
  private gainJitter: number[];
  private blinkAt = -1e9;
  private clenchUntil = -1;
  private moveAt = -1e9;
  private faults: ChannelFault[];
  private faultUntil: number[];
  distraction = 0;                     // 0 attentive .. 1 distracted
  eyesClosed = false;
  hum = false;
  autoArtifacts = true;                // random blinks / movement / flaky channel episodes
  private rnd: () => number;

  constructor(readonly channels: ChannelName[], sfreq = 125, seed = 7) {
    this.sfreq = sfreq;
    let s = seed >>> 0;
    this.rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    this.pink = channels.map(() => new Pink());
    this.alphaPhase = channels.map(() => this.rnd() * Math.PI * 2);
    this.alphaEnv = channels.map(() => 0.5);
    this.gainJitter = channels.map(() => 0.8 + this.rnd() * 0.5);
    this.faults = channels.map(() => "ok");
    this.faultUntil = channels.map(() => -1);
  }

  get timeS() { return this.t / this.sfreq; }

  blink() { this.blinkAt = this.t; }
  clench(seconds = 1.5) { this.clenchUntil = this.t + seconds * this.sfreq; }
  move() { this.moveAt = this.t; }
  setFault(ch: number, fault: ChannelFault, seconds = Infinity) {
    this.faults[ch] = fault;
    this.faultUntil[ch] = fault === "ok" ? -1 : this.t + seconds * this.sfreq;
  }
  faultOf(ch: number) { return this.faults[ch]; }

  private gauss() {
    const u = Math.max(1e-9, this.rnd()), v = this.rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Next n samples, [channel][sample] in uV. */
  next(n: number): number[][] {
    const out = this.channels.map(() => new Array<number>(n));
    const fs = this.sfreq;
    for (let k = 0; k < n; k++) {
      const t = this.t;
      if (this.autoArtifacts) {
        if (this.rnd() < 0.25 / fs) this.blink();                 // ~one blink every 4 s
        if (this.rnd() < 0.012 / fs) this.move();                 // a movement every ~80 s
        if (this.rnd() < 0.006 / fs) {                            // a flaky-contact episode every ~3 min on Pz
          const ch = Math.max(0, this.channels.indexOf("Pz"));
          this.setFault(ch, this.rnd() < 0.7 ? "noisy" : "flat", 6 + this.rnd() * 10);
        }
      }
      const blinkDt = (t - this.blinkAt) / fs;
      const blink = blinkDt >= 0 && blinkDt < 0.6 ? 130 * Math.exp(-(((blinkDt - 0.18) / 0.08) ** 2)) : 0;
      const moveDt = (t - this.moveAt) / fs;
      const move = moveDt >= 0 && moveDt < 1.4 ? 70 * Math.sin(Math.PI * moveDt / 1.4) * Math.sin(2 * Math.PI * 1.3 * moveDt) : 0;
      const clench = t < this.clenchUntil;

      for (let c = 0; c < this.channels.length; c++) {
        if (this.faultUntil[c] >= 0 && t > this.faultUntil[c]) this.setFault(c, "ok");
        const name = this.channels[c];
        if (this.faults[c] === "flat") { out[c][k] = 0.2 * this.gauss(); continue; }
        // background: pink noise
        let v = this.pink[c].next(this.gauss()) * 6.5 * this.gainJitter[c];
        // posterior alpha: envelope wanders, rises with distraction and eyes closed
        const post = POSTERIOR.has(name) ? 1 : 0.35;
        const target = post * (2.5 + 7 * this.distraction + (this.eyesClosed ? 14 : 0));
        if (k === 0) this.alphaEnv[c] += (target * (0.6 + 0.8 * this.rnd()) - this.alphaEnv[c]) * 0.08;
        this.alphaPhase[c] += (2 * Math.PI * (9.8 + 0.4 * Math.sin(t / fs / 7))) / fs;
        v += this.alphaEnv[c] * Math.sin(this.alphaPhase[c]);
        // frontal theta slightly up when attending (effort)
        if (name === "Fz") v += (1 - this.distraction) * 2.5 * Math.sin((2 * Math.PI * 6 * t) / fs);
        // artifacts
        if (name === "Fp1") v += blink; else if (name === "Fz") v += blink * 0.3;
        v += move * (0.6 + 0.4 * this.gainJitter[c]);
        if (clench) v += 35 * this.gauss();
        if (this.faults[c] === "noisy") v += 90 * this.gauss() + 60 * Math.sin((2 * Math.PI * 60 * t) / fs);
        if (this.hum) v += 18 * Math.sin((2 * Math.PI * 60 * t) / fs + c);
        out[c][k] = v;
      }
      this.t++;
    }
    return out;
  }
}
