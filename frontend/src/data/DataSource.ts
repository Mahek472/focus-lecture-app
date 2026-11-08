import type {
  ClientMessage, ConnectionState, Lapse, Lecture, Participant, Recap, RunHistory, SerialPortInfo,
  ServerMessage, SessionSummary, SignalCheckUpdate, StartSessionRequest, TranscriptLine,
} from "./types";

export type Unsubscribe = () => void;
export type MessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

/** Participant actions the mock can simulate during device setup (no-op for real hardware). */
export type SimulatedAction = "blink" | "clench" | "eyes_closed" | "eyes_open" | "fix_contact";

/**
 * Everything the UI needs from the backend. MockSource simulates it in the browser;
 * WebSocketSource talks to the FastAPI backend (REST + /ws/{run_id}) and the signal checker.
 */
export interface DataSource {
  readonly kind: "mock" | "websocket";

  // REST (contract)
  listLectures(): Promise<Lecture[]>;
  getTranscript(lectureId: string): Promise<TranscriptLine[]>;
  listSessions(): Promise<SessionSummary[]>;
  startSession(req: StartSessionRequest): Promise<{ run_id: string }>;
  startCalibration(runId: string): Promise<void>;
  getLapses(runId: string): Promise<Lapse[]>;
  getRecap(runId: string, language: string): Promise<Recap>;
  stopRun(runId: string): Promise<void>;

  // participants (local to the UI in both sources: not in contract)
  listParticipants(): Promise<Participant[]>;
  saveParticipant(p: Participant): Promise<void>;

  // run history for review/export (recorded by the UI while a run streams)
  getRunHistory(runId: string): Promise<RunHistory | null>;

  // WebSocket /ws/{run_id}
  connect(runId: string): void;
  disconnect(): void;
  on<T extends ServerMessage["type"]>(type: T, handler: (msg: MessageOf<T>) => void): Unsubscribe;
  onConnection(handler: (state: ConnectionState) => void): Unsubscribe;
  send(msg: ClientMessage): void;

  // device setup
  listPorts(): Promise<SerialPortInfo[]>;
  startSignalCheck(port: string, routeRld: boolean, handler: (u: SignalCheckUpdate) => void): Unsubscribe;
  simulate?(action: SimulatedAction): void;
}
