import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DataSource, MessageOf } from "../data/DataSource";
import type { ConnectionState, ServerMessage } from "../data/types";
import { MockSource } from "../data/mock/MockSource";
import { WebSocketSource } from "../data/WebSocketSource";
import { RunRecorder } from "../data/recorder";
import { useSettings } from "./settings";

interface Ctx { source: DataSource; recorder: RunRecorder }
const SourceContext = createContext<Ctx | null>(null);

/** VITE_DATA_SOURCE=websocket uses the real backend; anything else uses the in-browser mock. */
export function SourceProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const value = useMemo<Ctx>(() => ({
    source: import.meta.env.VITE_DATA_SOURCE === "websocket" ? new WebSocketSource() : new MockSource(settings.montage),
    recorder: new RunRecorder(),
  }), []); // eslint-disable-line react-hooks/exhaustive-deps -- one source for the app's lifetime
  // mock-only knobs follow Settings
  useEffect(() => {
    if (value.source instanceof MockSource) {
      value.source.rules = settings.rules;
      value.source.blockSeconds = settings.calibrationBlockS;
      value.source.hum = settings.mockHum;
      value.source.channels = settings.montage;
    }
  }, [value.source, settings.rules, settings.calibrationBlockS, settings.mockHum, settings.montage]);
  return <SourceContext.Provider value={value}>{children}</SourceContext.Provider>;
}

export function useSource() {
  const c = useContext(SourceContext);
  if (!c) throw new Error("useSource outside SourceProvider");
  return c;
}

/** Subscribe to one server message type for the component's lifetime. */
export function useServerMessage<T extends ServerMessage["type"]>(type: T, handler: (m: MessageOf<T>) => void) {
  const { source } = useSource();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => source.on(type, (m) => ref.current(m)), [source, type]);
}

export function useConnection(): ConnectionState {
  const { source } = useSource();
  const [state, setState] = useState<ConnectionState>("closed");
  useEffect(() => source.onConnection(setState), [source]);
  return state;
}
