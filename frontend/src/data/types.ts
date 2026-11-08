// Typed models for the Focus Lecture App backend contract
// ("Focus Lecture App: UI Guide and Backend Contract" + UI contract.md).
// Field names follow the contract exactly. Fields the contract does not define are optional
// and marked "not in contract" so the real backend is never assumed to send them.

export type ChannelName = string; // 10-10 label, e.g. "Fz"
export type Quality = "good" | "check" | "bad";
export type FocusState = "focused" | "drifting" | "unknown";
export type Truth = "attentive" | "distracted";
export type RunMode = "live" | "replay";
export type InterventionMode = "pause" | "alert" | "recap";
export type BandName = "delta" | "theta" | "alpha" | "beta";

export const BANDS: { name: BandName; label: string; symbol: string; lo: number; hi: number }[] = [
  { name: "delta", label: "Delta", symbol: "δ", lo: 1, hi: 4 },
  { name: "theta", label: "Theta", symbol: "θ", lo: 4, hi: 8 },
  { name: "alpha", label: "Alpha", symbol: "α", lo: 8, hi: 13 },
  { name: "beta", label: "Beta", symbol: "β", lo: 13, hi: 30 },
];

// ---------------------------------------------------------------- REST

export interface Lecture {
  id: string;
  title: string;
  video: string;            // video file URL from the backend (/video)
  length_s: number;
  youtube?: string;         // not in contract: lets the mock play the BBBD stimulus
}

export interface TranscriptLine {
  start: number;            // seconds into the video
  end: number;
  text: string;
}

export type SessionStatus = "scheduled" | "recording" | "complete" | "stopped";

export interface SessionSummary {
  run_id: string;
  lecture_id: string;
  lecture_title: string;
  participant_id: string;
  date: string;             // ISO date-time
  duration_s: number;
  mode: RunMode;
  status: SessionStatus;
  focused_fraction?: number; // not in contract
}

export interface StartSessionRequest {
  lecture_id: string;
  participant_id: string;
  mode: RunMode;
  intervention: InterventionMode; // contract: pause / alert / recap only
  sensitivity: number;            // contract: sensitivity slider, 0-1
}

export interface Lapse {
  start: number;            // video seconds
  end: number;
  snippet: string;          // what was said (transcript snippet)
}

export interface Flashcard {
  front: string;
  back: string;
}

export interface RecapItem {
  lapse: Lapse;
  summary: string[];        // summary bullets for this lapse
  flashcards: Flashcard[];
}

export interface Recap {
  run_id: string;
  focused_fraction: number; // % of time focused
  items: RecapItem[];
  language: string;
  note?: string;            // not in contract: e.g. "mock data"
}

// ---------------------------------------------------------------- WebSocket: backend -> frontend

/** Every second while the video plays. */
export interface FocusUpdate {
  type: "focus";
  t_video: number;
  score: number;                         // 0-1 focus estimate
  state: FocusState;
  quality: Record<ChannelName, Quality>;
  truth?: Truth;                         // replay only
  confidence?: number;                   // not in contract; 0-1 if the backend adds it
}

export interface BandPowerUpdate {
  type: "bands";
  t_video?: number;
  bands: Record<ChannelName, Record<BandName, number>>; // power, uV^2
}

export interface LapseStart { type: "lapse_start"; t_video: number }
export interface LapseEnd { type: "lapse_end"; t_video: number }
export type LapseEvent = LapseStart | LapseEnd;

/** Pause or alert command, with the video time to rewind to. */
export interface InterventionEvent {
  type: "intervention";
  action: "pause" | "alert";
  t_video: number;
  rewind_to: number;
}

export interface CalibrationProgress {
  type: "calibration";
  block: number;            // 1-based
  n_blocks: number;
  phase: "calibration" | "test";
  task: "watch" | "count";
  seconds_left: number;
  block_s: number;
  start_number?: number;    // prime to count back from (count blocks)
  done?: boolean;
  auc?: number;             // result once done
}

export type RunState = "idle" | "connecting" | "calibrating" | "ready" | "running" | "stopped" | "error";

export interface StatusUpdate {
  type: "status";
  state: RunState;
  message?: string;
  mode?: RunMode;
  sfreq?: number;
  camera?: { face_in_view: boolean; override: boolean; reason?: string }; // not in contract
}

/** Raw EEG samples. Not in contract: the real backend may never send this. */
export interface EegChunk {
  type: "eeg";
  sfreq: number;
  channels: ChannelName[];
  samples: number[][];      // [channel][sample], uV
}

export type ServerMessage =
  | FocusUpdate | BandPowerUpdate | LapseStart | LapseEnd | InterventionEvent | CalibrationProgress | StatusUpdate | EegChunk;

// ---------------------------------------------------------------- WebSocket: frontend -> backend

export interface VideoState {
  type: "video_state";
  t_video: number;
  playing: boolean;
}

export interface InterventionResponse {
  type: "intervention_response";
  choice: "rewind" | "focused" | "continue"; // Rewind / I was focused / Keep going
  t_video: number;
}

export interface Feedback {
  type: "feedback";
  kind: "false_alarm";      // "I was focused"
  t_video: number;
}

export interface SettingsMessage {
  type: "settings";
  intervention: InterventionMode;
  sensitivity: number;
}

/** Webcam attention state, computed in the browser (MediaPipe), sent once a second. Not in contract. */
export interface CameraMessage {
  type: "camera";
  t_video: number;
  state: "watching" | "face_missing" | "head_turned" | "head_down" | "eyes_off";
  face: boolean;
  head_turned: boolean;
  head_down: boolean;
  eyes_off: boolean;
  blink_rate: number | null;   // per minute; information only, never a lapse trigger
}

export type ClientMessage = VideoState | InterventionResponse | Feedback | SettingsMessage | CameraMessage;

// ---------------------------------------------------------------- local (operator) data

export interface Marker {
  id: string;
  t_video: number;
  label: string;
}

/** scripts/live_signal.py GET /data, polled ~4x per second during device setup. */
export interface SignalCheckUpdate {
  ready: boolean;
  sfreq?: number;
  traces?: number[][];      // last 5 s per channel, filtered, every 2nd sample
  sd?: number[];            // uV over the last 2 s
  ptp?: number[];
  hum?: number[];           // 60 Hz / 1-40 Hz power ratio (raw)
  alpha?: number[];         // 8-12 Hz share of 1-40 Hz
  dc?: number[];
  error?: string;           // UI-side: why the checker isn't running (busy port, unplugged board)
}

export interface SerialPortInfo {
  port: string;             // e.g. COM7
  description: string;      // e.g. USB Serial Port
}

export interface Participant {
  id: string;
  name: string;
  consent_eeg: boolean;
  consent_webcam: boolean;
  calibration_date?: string;
  calibration_auc?: number;
  notes: string;
}

/** Everything recorded for one run, used by recap/review and export. */
export interface RunHistory {
  run_id: string;
  focus: FocusUpdate[];
  bands: BandPowerUpdate[];
  lapses: Lapse[];
  markers: Marker[];
  eeg?: { sfreq: number; channels: ChannelName[]; data: Float32Array[]; t0: number }; // t0 = video time of sample 0
}

export type ConnectionState = "connecting" | "open" | "closed" | "reconnecting";
