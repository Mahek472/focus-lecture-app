import type { ConnectionState, FocusState, Quality } from "../data/types";

// Every state is shown with an icon and a word, never colour alone (contract: inclusive UI).

export function Icon({ name, size = 12 }: { name: "good" | "check" | "bad" | "warn" | "dot" | "ring" | "camera"; size?: number }) {
  const s = size;
  switch (name) {
    case "good": return <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden><circle cx="6" cy="6" r="5" fill="currentColor" /><path d="M3.4 6.2l1.8 1.8 3.6-3.8" stroke="var(--raised)" strokeWidth="1.6" fill="none" /></svg>;
    case "check": return <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden><circle cx="6" cy="6" r="4.7" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M6 1.3a4.7 4.7 0 0 1 0 9.4z" fill="currentColor" /></svg>;
    case "bad": return <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden><rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" /><path d="M4 4l4 4M8 4l-4 4" stroke="var(--raised)" strokeWidth="1.6" /></svg>;
    case "warn": return <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden><path d="M6 1l5 9.5H1z" fill="currentColor" /><path d="M6 4.5v3M6 8.6v.4" stroke="var(--raised)" strokeWidth="1.4" /></svg>;
    case "dot": return <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden><circle cx="6" cy="6" r="4" fill="currentColor" /></svg>;
    case "ring": return <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden><circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
    case "camera": return <svg width={s} height={s} viewBox="0 0 14 12" aria-hidden><rect x="1" y="3" width="9" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M10 6l3-2v5l-3-2z" fill="currentColor" /></svg>;
  }
}

export const QUALITY_WORD: Record<Quality, string> = { good: "Good", check: "Check", bad: "Bad" };

export function QualityStatus({ q, label }: { q: Quality; label?: string }) {
  return <span className={`status status--${q}`}><Icon name={q} />{label ?? QUALITY_WORD[q]}</span>;
}

export const FOCUS_WORD: Record<FocusState, string> = { focused: "Focused", drifting: "Drifting", unknown: "Unknown" };

export function FocusStatus({ state }: { state: FocusState }) {
  const cls = state === "drifting" ? "warn" : state === "focused" ? "good" : "neutral";
  const icon = state === "drifting" ? "warn" : state === "focused" ? "dot" : "ring";
  return <span className={`status status--${cls}`}><Icon name={icon} />{FOCUS_WORD[state]}</span>;
}

const CONN: Record<ConnectionState, { word: string; cls: string; icon: "good" | "check" | "bad" | "ring" }> = {
  open: { word: "Connected", cls: "good", icon: "good" },
  connecting: { word: "Connecting", cls: "check", icon: "check" },
  reconnecting: { word: "Reconnecting", cls: "check", icon: "check" },
  closed: { word: "Not connected", cls: "neutral", icon: "ring" },
};

export function ConnectionStatus({ state, kind }: { state: ConnectionState; kind: "mock" | "websocket" }) {
  const c = CONN[state];
  return (
    <span className="connection" role="status" aria-live="polite">
      <span className={`status status--${c.cls}`}><Icon name={c.icon} />{c.word}</span>
      <span className="tag">{kind === "mock" ? "Mock data" : "Backend"}</span>
    </span>
  );
}
