// Small DSP helpers: biquad filters (same display filtering as scripts/live_signal.py:
// 60 Hz notch + 1-40 Hz band-pass) and an FFT for band power.

export class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;

  static lowpass(fs: number, f: number, q = Math.SQRT1_2) { return new Biquad().set("lp", fs, f, q); }
  static highpass(fs: number, f: number, q = Math.SQRT1_2) { return new Biquad().set("hp", fs, f, q); }
  static notch(fs: number, f: number, q = 30) { return new Biquad().set("notch", fs, f, q); }

  private set(kind: "lp" | "hp" | "notch", fs: number, f: number, q: number) {
    const w = (2 * Math.PI * Math.min(f, fs * 0.49)) / fs, cw = Math.cos(w), alpha = Math.sin(w) / (2 * q);
    let b0: number, b1: number, b2: number;
    if (kind === "lp") { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
    else if (kind === "hp") { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
    else { b0 = 1; b1 = -2 * cw; b2 = 1; }
    const a0 = 1 + alpha;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = (-2 * cw) / a0; this.a2 = (1 - alpha) / a0;
    return this;
  }

  step(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** Display filter chain for one channel: notch, high-pass 1 Hz, low-pass 40 Hz. */
export class DisplayFilter {
  private chain: Biquad[];
  constructor(fs: number, notchHz: 50 | 60 = 60) {
    this.chain = [Biquad.notch(fs, notchHz), Biquad.highpass(fs, 1), Biquad.lowpass(fs, 40)];
  }
  step(x: number) { let y = x; for (const f of this.chain) y = f.step(y); return y; }
}

/** In-place radix-2 FFT. re/im length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/** One-sided power spectrum (uV^2 per bin) of the last `n` samples (n = power of two), Hann window. */
export function powerSpectrum(x: ArrayLike<number>, fs: number, n = 256) {
  const re = new Float64Array(n), im = new Float64Array(n);
  const off = Math.max(0, x.length - n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += (x[off + i] ?? 0) / n;
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = ((x[off + i] ?? 0) - mean) * w; wsum += w * w;
  }
  fft(re, im);
  const p = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) p[k] = ((re[k] ** 2 + im[k] ** 2) / wsum) * (k === 0 || k === n / 2 ? 1 : 2);
  return { p, df: fs / n };
}

export function bandSum(spec: { p: Float64Array; df: number }, lo: number, hi: number) {
  let s = 0;
  for (let k = 0; k < spec.p.length; k++) { const f = k * spec.df; if (f >= lo && f < hi) s += spec.p[k]; }
  return s;
}

export function std(x: ArrayLike<number>, from = 0) {
  let m = 0; const n = x.length - from;
  if (n <= 1) return 0;
  for (let i = from; i < x.length; i++) m += x[i] / n;
  let v = 0;
  for (let i = from; i < x.length; i++) v += (x[i] - m) ** 2 / n;
  return Math.sqrt(v);
}
