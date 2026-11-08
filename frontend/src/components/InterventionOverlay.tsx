import { useEffect, useRef } from "react";
import type { InterventionEvent, InterventionResponse } from "../data/types";
import { fmtTime } from "../lib/format";

// Contract: pause overlay ("Looks like you drifted at 12:40" with Rewind / I was focused /
// Keep going) or a gentle toast. Calm styling: no warm colour, no motion, no alarm wording.

interface Props {
  event: InterventionEvent;
  onChoice: (choice: InterventionResponse["choice"]) => void;
}

export function InterventionOverlay({ event, onChoice }: Props) {
  const first = useRef<HTMLButtonElement>(null);
  const pause = event.action === "pause";
  useEffect(() => {
    if (pause) first.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onChoice("continue"); };
    window.addEventListener("keydown", onKey);
    const auto = pause ? 0 : window.setTimeout(() => onChoice("continue"), 15000);
    return () => { window.removeEventListener("keydown", onKey); clearTimeout(auto); };
  }, [pause, onChoice]);

  const body = (
    <>
      <p style={{ fontWeight: 600 }}>Looks like your attention drifted around {fmtTime(event.rewind_to + 2)}.</p>
      <p className="small muted">This is an estimate from your EEG, and it can be wrong.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        <button ref={first} className="btn btn--primary" onClick={() => onChoice("rewind")}>Rewind to {fmtTime(event.rewind_to)}</button>
        <button className="btn" onClick={() => onChoice("focused")}>I was focused</button>
        <button className="btn btn--quiet" onClick={() => onChoice("continue")}>Keep going</button>
      </div>
    </>
  );

  if (pause) {
    return (
      <div role="dialog" aria-modal="true" aria-label="Attention check"
        style={{ position: "absolute", inset: 0, background: "rgba(11,15,19,0.55)", display: "grid", placeItems: "center", padding: 16, zIndex: 5 }}>
        <div style={{ background: "var(--raised)", color: "var(--text)", border: "1px solid var(--rule-strong)", borderRadius: 4,
          padding: "16px 18px", maxWidth: 440, boxShadow: "var(--shadow-overlay)" }}>
          <p className="small muted" style={{ marginBottom: 4 }}>Video paused</p>
          {body}
        </div>
      </div>
    );
  }
  return (
    <div role="status" aria-live="polite"
      style={{ position: "absolute", right: 12, bottom: 64, zIndex: 5, background: "var(--raised)", color: "var(--text)",
        border: "1px solid var(--rule-strong)", borderLeft: "3px solid var(--accent)", borderRadius: 4, padding: "12px 14px",
        maxWidth: 380, boxShadow: "var(--shadow-overlay)" }}>
      {body}
    </div>
  );
}
