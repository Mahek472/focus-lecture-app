export function fmtTime(s: number) {
  const t = Math.max(0, Math.round(s));
  const m = Math.floor(t / 60), sec = t % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function fmtDuration(s: number) {
  if (!s) return "–";
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return m ? `${m} min ${sec} s` : `${sec} s`;
}

export function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;

/** Read a CSS custom property (resolved for the current theme). */
export function cssVar(name: string, el: Element = document.documentElement) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}
