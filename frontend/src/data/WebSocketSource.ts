import type { DataSource, MessageOf, Unsubscribe } from "./DataSource";
import type {
  ClientMessage, ConnectionState, Lapse, Lecture, Participant, Recap, RunHistory, SerialPortInfo, ServerMessage,
  SessionSummary, SignalCheckUpdate, StartSessionRequest, TranscriptLine,
} from "./types";

// Real backend: FastAPI REST under /api (proxied to :8000), WebSocket /ws/{run_id}, and the
// signal checker (scripts/live_signal.py) under /signal (proxied to :8766). Request shapes the
// contract leaves open are listed in frontend/README.md under "To confirm with the backend".

const API = "/api";
const LOCAL_SESSIONS = "wdim.sessions";
const LOCAL_PARTICIPANTS = "wdim.participants";

function readLocal<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function writeLocal(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable: keep in memory only */ }
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + path, { headers: { "Content-Type": "application/json" }, ...init });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${r.status}`);
  return (await r.json()) as T;
}

export class WebSocketSource implements DataSource {
  readonly kind = "websocket" as const;
  private ws: WebSocket | null = null;
  private runId = "";
  private retry = 0;
  private retryTimer = 0;
  private wanted = false;
  private handlers = new Map<string, Set<(m: never) => void>>();
  private connHandlers = new Set<(s: ConnectionState) => void>();
  private outbox: ClientMessage[] = [];
  private sessions: SessionSummary[] = readLocal(LOCAL_SESSIONS, []);
  private participants: Participant[] = readLocal(LOCAL_PARTICIPANTS, []);

  // ---------------------------------------------------------------- REST
  async listLectures() {
    const r = await http<Lecture[] | { lectures: Lecture[] }>("/sessions");
    const lectures = Array.isArray(r) ? r : r.lectures;
    return lectures.map((l) => ({ ...l, video: l.video || `${API}/video?lecture_id=${encodeURIComponent(l.id)}` }));
  }
  async getTranscript(lectureId: string) {
    const r = await http<TranscriptLine[] | { lines: TranscriptLine[] }>(`/transcript?lecture_id=${encodeURIComponent(lectureId)}`);
    return Array.isArray(r) ? r : r.lines;
  }
  async listSessions() { return [...this.sessions].sort((a, b) => b.date.localeCompare(a.date)); }

  async startSession(req: StartSessionRequest) {
    const r = await http<{ run_id: string }>("/session/start", { method: "POST", body: JSON.stringify(req) });
    const lectures = await this.listLectures().catch(() => [] as Lecture[]);
    this.sessions.push({ run_id: r.run_id, lecture_id: req.lecture_id,
      lecture_title: lectures.find((l) => l.id === req.lecture_id)?.title ?? req.lecture_id,
      participant_id: req.participant_id, date: new Date().toISOString(), duration_s: 0, mode: req.mode, status: "recording" });
    writeLocal(LOCAL_SESSIONS, this.sessions);
    return r;
  }
  async startCalibration(runId: string) {
    await http("/calibration/start", { method: "POST", body: JSON.stringify({ run_id: runId }) });
  }
  async getLapses(runId: string) {
    const r = await http<Lapse[] | { lapses: Lapse[] }>(`/run/${runId}/lapses`);
    return Array.isArray(r) ? r : r.lapses;
  }
  async getRecap(runId: string, language: string) {
    return http<Recap>(`/run/${runId}/recap?lang=${encodeURIComponent(language)}`);
  }
  async stopRun(runId: string) {
    await http(`/run/${runId}/stop`, { method: "POST" });
    const s = this.sessions.find((x) => x.run_id === runId);
    if (s) { s.status = "complete"; s.duration_s = Math.round((Date.now() - new Date(s.date).getTime()) / 1000); }
    writeLocal(LOCAL_SESSIONS, this.sessions);
  }

  async listParticipants() { return this.participants.map((p) => ({ ...p })); }
  async saveParticipant(p: Participant) {
    const i = this.participants.findIndex((x) => x.id === p.id);
    if (i >= 0) this.participants[i] = { ...p }; else this.participants.push({ ...p });
    writeLocal(LOCAL_PARTICIPANTS, this.participants);
  }

  /** The backend serves no history endpoint; the UI's recorder keeps what streamed. */
  async getRunHistory(): Promise<RunHistory | null> { return null; }

  // ---------------------------------------------------------------- WebSocket
  connect(runId: string) {
    this.disconnect();
    this.runId = runId; this.wanted = true; this.retry = 0;
    this.open();
  }

  private open() {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${encodeURIComponent(this.runId)}`;
    this.setConn(this.retry ? "reconnecting" : "connecting");
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0; this.setConn("open");
      for (const m of this.outbox.splice(0)) ws.send(JSON.stringify(m));
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data as string) as ServerMessage;
        this.handlers.get(m.type)?.forEach((h) => (h as (x: ServerMessage) => void)(m));
      } catch { /* ignore malformed frames */ }
    };
    ws.onclose = () => {
      if (!this.wanted) { this.setConn("closed"); return; }
      this.retry++;
      this.setConn("reconnecting");
      this.retryTimer = window.setTimeout(() => this.open(), Math.min(8000, 500 * 2 ** this.retry));
    };
    ws.onerror = () => ws.close();
  }

  disconnect() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
  }

  on<T extends ServerMessage["type"]>(type: T, handler: (msg: MessageOf<T>) => void): Unsubscribe {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler as (m: never) => void);
    this.handlers.set(type, set);
    return () => set.delete(handler as (m: never) => void);
  }
  onConnection(handler: (s: ConnectionState) => void) { this.connHandlers.add(handler); return () => this.connHandlers.delete(handler); }
  private setConn(s: ConnectionState) { this.connHandlers.forEach((h) => h(s)); }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else if (msg.type !== "video_state") this.outbox.push(msg); // stale video times are not worth replaying
  }

  // ---------------------------------------------------------------- device setup
  /** No port-listing endpoint exists; the UI asks the operator to type the port. */
  async listPorts(): Promise<SerialPortInfo[]> { return []; }

  /** Polls scripts/live_signal.py (started by the operator with the shown command). */
  startSignalCheck(_port: string, _routeRld: boolean, handler: (u: SignalCheckUpdate) => void): Unsubscribe {
    let stop = false;
    const poll = async () => {
      while (!stop) {
        try {
          const r = await fetch("/signal/data");
          handler(r.ok ? ((await r.json()) as SignalCheckUpdate) : { ready: false });
        } catch { handler({ ready: false }); }
        await new Promise((res) => setTimeout(res, 250));
      }
    };
    void poll();
    return () => { stop = true; };
  }
}
