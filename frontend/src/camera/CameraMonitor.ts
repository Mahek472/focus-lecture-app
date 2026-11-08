// Webcam attention signals with MediaPipe Face Landmarker, all in the browser (video never leaves
// the laptop): face missing, head turned, head down, eyes off screen, and blink rate.
//
// Head pose comes from 3-D landmarks (MediaPipe z: smaller = closer to the camera):
//   yaw   = angle of the eye-corner line (33 -> 263) in the x-z plane
//   pitch = angle of the forehead -> chin line (10 -> 152) in the y-z plane; grows when looking down
// Both are taken relative to the person's own "looking at the screen" pose (gaze calibration, or the
// first seconds if not calibrated). Eye direction comes from MediaPipe's eyeLook* blendshapes.
// Eyes off screen: with gaze calibration, a ridge regression from [yaw, pitch, eyeH, eyeV] to screen
// coordinates (corners = +/-1) and "off" beyond +/-1.3. Without calibration eyes-off stays off
// (head and face checks still run): uncalibrated eye thresholds proved too twitchy.
// Blinks: mean eyeBlink score crossing 0.55 (closed) and back under 0.35 within 0.5 s.
// Every flag must hold for 1 s to switch on and 0.5 s to switch off, so a glance doesn't count.

import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";

export type CameraState = "watching" | "face_missing" | "head_turned" | "head_down" | "eyes_off";

export interface CameraReading {
  t: number;                 // performance.now() ms
  running: boolean;
  fps: number;
  delegate: "GPU" | "CPU" | null;
  face: boolean;
  headTurned: boolean;
  headDown: boolean;
  eyesOff: boolean;
  state: CameraState;        // highest-priority flag that is on
  yawDeg: number | null;     // relative to the person's on-screen pose
  pitchDeg: number | null;
  gaze: { x: number; y: number } | null;   // screen coordinates (corners +/-1), only when gaze-calibrated
  blinkRate: number | null;  // blinks per minute over the last 60 s
  calibrated: boolean;
  error?: string;
}

export const STATE_WORD: Record<CameraState, string> = {
  watching: "Looking at the screen", face_missing: "Face not in view", head_turned: "Head turned away",
  head_down: "Head down", eyes_off: "Eyes off screen",
};

const TURN_DEG = 25, DOWN_DEG = 18, UP_DEG = 20, OFF_LIMIT = 1.3;
const ON_MS = 1000, OFF_MS = 500;

interface Features { yaw: number; pitch: number; eyeH: number; eyeV: number }

class Debounce {
  value = false; private since = 0;
  update(raw: boolean, now: number) {
    if (raw === this.value) { this.since = now; return this.value; }
    if (now - this.since >= (raw ? ON_MS : OFF_MS)) { this.value = raw; this.since = now; }
    return this.value;
  }
}

const deg = (r: number) => (r * 180) / Math.PI;

function features(res: FaceLandmarkerResult, aspect: number): Features | null {
  const lm = res.faceLandmarks?.[0];
  if (!lm) return null;
  const P = (i: number) => ({ x: lm[i].x, y: lm[i].y / aspect, z: lm[i].z }); // y in x units
  const a = P(33), b = P(263), top = P(10), chin = P(152);
  const yaw = deg(Math.atan2(b.z - a.z, b.x - a.x));
  const pitch = deg(Math.atan2(chin.z - top.z, chin.y - top.y));
  const s = Object.fromEntries((res.faceBlendshapes?.[0]?.categories ?? []).map((c) => [c.categoryName, c.score]));
  // + = looking to the person's left / up. Left eye looking left = lookOut; right eye looking left = lookIn.
  const eyeH = (((s.eyeLookOutLeft ?? 0) - (s.eyeLookInLeft ?? 0)) + ((s.eyeLookInRight ?? 0) - (s.eyeLookOutRight ?? 0))) / 2;
  const eyeV = (((s.eyeLookUpLeft ?? 0) + (s.eyeLookUpRight ?? 0)) - ((s.eyeLookDownLeft ?? 0) + (s.eyeLookDownRight ?? 0))) / 2;
  return { yaw, pitch, eyeH, eyeV, blink: ((s.eyeBlinkLeft ?? 0) + (s.eyeBlinkRight ?? 0)) / 2 } as Features & { blink: number };
}

/** Ridge regression from features to screen x / y, fitted on gaze-calibration samples. */
function fitGaze(samples: { f: Features; x: number; y: number }[]) {
  const rows = samples.map(({ f }) => [1, f.yaw / 30, f.pitch / 30, f.eyeH, f.eyeV]);
  const k = rows[0].length, lambda = 0.05;
  const solve = (target: number[]) => {
    const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => rows.reduce((s, r) => s + r[i] * r[j], 0) + (i === j && i > 0 ? lambda * rows.length : 0)));
    const v = Array.from({ length: k }, (_, i) => rows.reduce((s, r, n) => s + r[i] * target[n], 0));
    for (let i = 0; i < k; i++) {             // Gauss-Jordan
      let p = i; for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]]; [v[i], v[p]] = [v[p], v[i]];
      for (let r = 0; r < k; r++) if (r !== i) { const m = A[r][i] / A[i][i]; for (let c = i; c < k; c++) A[r][c] -= m * A[i][c]; v[r] -= m * v[i]; }
    }
    return v.map((x, i) => x / A[i][i]);
  };
  const wx = solve(samples.map((s) => s.x)), wy = solve(samples.map((s) => s.y));
  return (f: Features) => {
    const r = [1, f.yaw / 30, f.pitch / 30, f.eyeH, f.eyeV];
    return { x: r.reduce((s, v, i) => s + v * wx[i], 0), y: r.reduce((s, v, i) => s + v * wy[i], 0) };
  };
}

export class CameraMonitor {
  private landmarker: FaceLandmarker | null = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private raf = 0;
  private listeners = new Set<(r: CameraReading) => void>();
  private delegate: "GPU" | "CPU" | null = null;
  private frames: number[] = [];
  private baseline: { yaw: number; pitch: number } | null = null;
  private baselineSamples: Features[] = [];
  private gaze: ((f: Features) => { x: number; y: number }) | null = null;
  private collecting: { x: number; y: number; samples: { f: Features; x: number; y: number }[] } | null = null;
  private blinkClosedAt: number | null = null;
  private blinks: number[] = [];
  private startedAt = 0;
  private deb = { face: new Debounce(), turned: new Debounce(), down: new Debounce(), off: new Debounce() };
  last: CameraReading = this.empty();

  private empty(error?: string): CameraReading {
    return { t: performance.now(), running: false, fps: 0, delegate: this.delegate, face: false, headTurned: false, headDown: false,
      eyesOff: false, state: "face_missing", yawDeg: null, pitchDeg: null, gaze: null, blinkRate: null, calibrated: !!this.gaze, error };
  }

  get running() { return !!this.stream; }
  get previewStream() { return this.stream; }
  onReading(fn: (r: CameraReading) => void) { this.listeners.add(fn); fn(this.last); return () => this.listeners.delete(fn); }
  private emit(r: CameraReading) { this.last = r; this.listeners.forEach((f) => f(r)); }

  async start() {
    if (this.stream) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: 30 }, audio: false });
    } catch (e) {
      this.emit(this.empty(`Webcam not available (${(e as Error).name})`)); return;
    }
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.srcObject = this.stream;
    await v.play();
    this.video = v;
    if (!(await this.ensureModel())) { this.stop(); return; }
    this.startedAt = performance.now();
    this.loop();
  }

  private async ensureModel() {
    if (this.landmarker) return true;
    try {
      const files = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      const make = (delegate: "GPU" | "CPU") => FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: "/models/face_landmarker.task", delegate },
        runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true,
      });
      try { this.landmarker = await make("GPU"); this.delegate = "GPU"; }
      catch { this.landmarker = await make("CPU"); this.delegate = "CPU"; }
      return true;
    } catch (e) {
      this.emit(this.empty(`Face model failed to load (${(e as Error).message}). Run npm run dev once with internet.`));
      return false;
    }
  }

  /** Analyse a video element the page plays (e.g. a recorded webcam clip) instead of the live webcam. */
  async attachVideo(v: HTMLVideoElement) {
    this.detachVideo();
    if (!(await this.ensureModel())) return;
    this.video = v;
    this.baseline = null; this.baselineSamples = []; this.blinks = []; this.blinkClosedAt = null; this.frames = [];
    this.deb = { face: new Debounce(), turned: new Debounce(), down: new Debounce(), off: new Debounce() };
    this.startedAt = performance.now();
    this.loop();
  }
  detachVideo() { cancelAnimationFrame(this.raf); if (!this.stream) this.video = null; }
  get blinkTimes() { return this.blinks; }

  stop() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
    this.emit({ ...this.empty(), running: false });
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const v = this.video, lmk = this.landmarker;
    if (!v || !lmk || v.readyState < 2 || (!this.stream && v.paused)) return;   // a paused review clip needs no work
    const now = performance.now();
    if (this.frames.length && now - this.frames[this.frames.length - 1] < 30) return; // cap ~33 fps
    const res = lmk.detectForVideo(v, now);
    this.frames.push(now); while (this.frames.length && now - this.frames[0] > 1000) this.frames.shift();
    this.process(res, now, v.videoHeight ? v.videoWidth / v.videoHeight : 4 / 3);
  };

  private process(res: FaceLandmarkerResult, now: number, aspect: number) {
    const f = features(res, aspect) as (Features & { blink: number }) | null;
    if (this.collecting && f) this.collecting.samples.push({ f, x: this.collecting.x, y: this.collecting.y });
    // uncalibrated: the first 60 face frames (about 2 s) become the person's on-screen pose
    if (f && !this.baseline && this.baselineSamples.length < 60) this.baselineSamples.push(f);
    if (f && !this.baseline && this.baselineSamples.length >= 60) {
      const n = this.baselineSamples.length;
      this.baseline = { yaw: this.baselineSamples.reduce((s, x) => s + x.yaw, 0) / n, pitch: this.baselineSamples.reduce((s, x) => s + x.pitch, 0) / n };
    }
    const base = this.baseline ?? { yaw: f?.yaw ?? 0, pitch: f?.pitch ?? 0 };
    const yaw = f ? f.yaw - base.yaw : null, pitch = f ? f.pitch - base.pitch : null;

    // blinks (only while the face is clearly visible and roughly frontal)
    if (f && Math.abs(yaw!) < TURN_DEG) {
      if (f.blink > 0.55 && this.blinkClosedAt === null) this.blinkClosedAt = now;
      if (f.blink < 0.35 && this.blinkClosedAt !== null) { if (now - this.blinkClosedAt < 500) this.blinks.push(now); this.blinkClosedAt = null; }
    }
    while (this.blinks.length && now - this.blinks[0] > 60000) this.blinks.shift();
    const elapsed = Math.min(60000, now - this.startedAt);

    // eyes off screen only with gaze calibration: uncalibrated eye thresholds flicker (e.g. glancing at captions)
    const gaze = f && this.gaze ? this.gaze(f) : null;
    const rawOff = !!gaze && (Math.abs(gaze.x) > OFF_LIMIT || Math.abs(gaze.y) > OFF_LIMIT);
    const face = this.deb.face.update(!!f, now);
    const turned = this.deb.turned.update(!!f && (Math.abs(yaw!) > TURN_DEG || pitch! < -UP_DEG), now);
    const down = this.deb.down.update(!!f && pitch! > DOWN_DEG, now);
    const off = this.deb.off.update(rawOff, now);
    const state: CameraState = !face ? "face_missing" : turned ? "head_turned" : down ? "head_down" : off ? "eyes_off" : "watching";
    this.emit({ t: now, running: true, fps: this.frames.length, delegate: this.delegate, face, headTurned: turned, headDown: down, eyesOff: off,
      state, yawDeg: yaw, pitchDeg: pitch, gaze, calibrated: !!this.gaze,
      blinkRate: elapsed > 15000 ? (this.blinks.length * 60000) / elapsed : null });
  }

  // ---------------------------------------------------------------- gaze calibration
  /** Collect samples while the person looks at a target (screen coords, corners +/-1). */
  beginTarget(x: number, y: number) { this.collecting = { x, y, samples: this.collecting?.samples ?? [] }; }
  /** Drop the first `settleMs` of the current target (eyes still moving) by trimming its earliest samples. */
  pauseCollecting() { if (this.collecting) this.collecting = { ...this.collecting, x: NaN, y: NaN }; }
  finishCalibration(): { ok: boolean; reason?: string } {
    const all = (this.collecting?.samples ?? []).filter((s) => !Number.isNaN(s.x));
    this.collecting = null;
    const targets = new Set(all.map((s) => `${s.x},${s.y}`));
    if (targets.size < 5 || all.length < 40) return { ok: false, reason: "Not enough face samples. Check lighting and that the face is in view." };
    const centre = all.filter((s) => s.x === 0 && s.y === 0).map((s) => s.f);
    this.baseline = { yaw: centre.reduce((a, f) => a + f.yaw, 0) / centre.length, pitch: centre.reduce((a, f) => a + f.pitch, 0) / centre.length };
    const rel = all.map((s) => ({ ...s, f: { ...s.f, yaw: s.f.yaw - this.baseline!.yaw, pitch: s.f.pitch - this.baseline!.pitch } }));
    const fit = fitGaze(rel);
    const base = this.baseline;
    this.gaze = (f) => fit({ ...f, yaw: f.yaw - base.yaw, pitch: f.pitch - base.pitch });
    return { ok: true };
  }
  clearCalibration() { this.gaze = null; this.baseline = null; this.baselineSamples = []; this.startedAt = performance.now(); }
}

/** One monitor for the whole app, so the camera and calibration survive moving between screens. */
export const camera = new CameraMonitor();
if (import.meta.env.DEV) (window as unknown as { __camera: CameraMonitor }).__camera = camera; // inspect from the console
