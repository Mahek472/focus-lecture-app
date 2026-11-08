import type { RunHistory } from "../data/types";
import { toPoints } from "./uncertainty";

function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** One row per focus update, with lapse and marker columns, for the whole run or a time range. */
export function exportCsv(hist: RunHistory, name: string, range?: [number, number]) {
  const pts = toPoints(hist.focus).filter((p) => !range || (p.t >= range[0] && p.t <= range[1]));
  const bandsAt = new Map(hist.bands.map((b) => [Math.round(b.t_video ?? -1), b.bands]));
  const header = ["t_video_s", "focus_estimate", "uncertainty_low", "uncertainty_high", "state", "unreliable",
    "in_lapse", "lapse_reason", "camera_state", "truth", "marker", "delta_mean", "theta_mean", "alpha_mean", "beta_mean"];
  const rows = pts.map((p) => {
    const lapse = hist.lapses.find((l) => p.t >= l.start && p.t <= l.end), inLapse = !!lapse;
    const cam = hist.camera?.find((c) => Math.round(c.t_video) === Math.round(p.t))?.state ?? "";
    const marker = hist.markers.filter((m) => Math.round(m.t_video) === Math.round(p.t)).map((m) => m.label).join("; ");
    const b = bandsAt.get(Math.round(p.t));
    const mean = (k: "delta" | "theta" | "alpha" | "beta") => {
      if (!b) return "";
      const v = Object.values(b).map((x) => x[k]);
      return (v.reduce((a, c) => a + c, 0) / v.length).toFixed(3);
    };
    return [p.t, p.score.toFixed(3), p.lo.toFixed(3), p.hi.toFixed(3), p.state, p.unreliable, inLapse, lapse?.reason ?? "", cam, p.truth ?? "",
      `"${marker.replace(/"/g, "'")}"`, mean("delta"), mean("theta"), mean("alpha"), mean("beta")].join(",");
  });
  download(name, new Blob([[header.join(","), ...rows].join("\n")], { type: "text/csv" }));
}

export function exportPng(canvas: HTMLCanvasElement, name: string) {
  canvas.toBlob((b) => b && download(name, b), "image/png");
}
