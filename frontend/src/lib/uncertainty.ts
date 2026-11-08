// The contract's focus message carries no confidence value. Until the backend adds one, the UI
// derives an uncertainty band from what it does have, and labels it as such:
//   half-width = 1.5 x the spread of the last 5 scores + 0.06, + 0.08 per channel with bad contact.
// A window is "unreliable" when the backend says state = unknown or 2+ channels are bad.
// If the backend sends `confidence`, it is used instead.

import type { FocusUpdate } from "../data/types";

export interface FocusPoint {
  t: number;
  score: number;
  lo: number;
  hi: number;
  unreliable: boolean;
  state: FocusUpdate["state"];
  truth?: FocusUpdate["truth"];
}

export const UNCERTAINTY_SOURCE = (points: FocusUpdate[]) =>
  points.some((p) => p.confidence !== undefined) ? "backend confidence" : "estimated in the UI from score spread and signal quality";

export function toPoints(updates: FocusUpdate[]): FocusPoint[] {
  return updates.map((u, i) => {
    const bad = Object.values(u.quality ?? {}).filter((q) => q === "bad").length;
    let hw: number;
    if (u.confidence !== undefined) hw = 0.05 + (1 - u.confidence) * 0.35;
    else {
      const win = updates.slice(Math.max(0, i - 4), i + 1).map((x) => x.score);
      const m = win.reduce((a, b) => a + b, 0) / win.length;
      const sd = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / win.length);
      hw = 1.5 * sd + 0.06 + 0.08 * bad;
    }
    const unreliable = u.state === "unknown" || bad >= 2;
    if (unreliable) hw = Math.max(hw, 0.3);
    return { t: u.t_video, score: u.score, lo: Math.max(0, u.score - hw), hi: Math.min(1, u.score + hw),
             unreliable, state: u.state, truth: u.truth };
  });
}
