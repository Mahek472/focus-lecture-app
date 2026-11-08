import type { Quality } from "../data/types";

// Top-down 10-10 layout, nose up, left hemisphere on the left. Unit-circle coordinates.
const POS: Record<string, [number, number]> = {
  Fp1: [-0.3, -0.84], Fp2: [0.3, -0.84], F7: [-0.72, -0.5], F3: [-0.38, -0.44], Fz: [0, -0.42], F4: [0.38, -0.44],
  F8: [0.72, -0.5], T7: [-0.88, 0], C3: [-0.44, 0], Cz: [0, 0], C4: [0.44, 0], T8: [0.88, 0],
  P7: [-0.72, 0.5], P3: [-0.38, 0.44], Pz: [0, 0.42], P4: [0.38, 0.44], P8: [0.72, 0.5],
  POz: [0, 0.64], O1: [-0.3, 0.84], Oz: [0, 0.86], O2: [0.3, 0.84],
};

interface Props {
  channels: string[];
  quality: Record<string, Quality | undefined>;
  values?: Record<string, string>;   // e.g. "12 µV" under each electrode
  selected?: string;
  onSelect?: (ch: string) => void;
  size?: number;
  compact?: boolean;
}

const FILL: Record<Quality, string> = { good: "var(--ok)", check: "var(--check)", bad: "var(--signal)" };
const WORD: Record<Quality, string> = { good: "good contact", check: "check contact", bad: "bad contact" };

export function HeadMap({ channels, quality, values, selected, onSelect, size = 280, compact }: Props) {
  const R = 100, pad = 18, vb = R * 2 + pad * 2, r = compact ? 9 : 12;
  const xy = (ch: string) => { const [x, y] = POS[ch] ?? [0, 0]; return [pad + R + x * R * 0.92, pad + R + y * R * 0.92]; };
  return (
    <svg viewBox={`0 0 ${vb} ${vb}`} width={size} height={size} role="group" aria-label="Electrode contact map, top-down view, nose up">
      <circle cx={pad + R} cy={pad + R} r={R} fill="var(--raised)" stroke="var(--rule-strong)" strokeWidth={1.5} />
      <path d={`M${pad + R - 12} ${pad + 2} L${pad + R} ${pad - 12} L${pad + R + 12} ${pad + 2}`} fill="none" stroke="var(--rule-strong)" strokeWidth={1.5} />
      <path d={`M${pad - 1} ${pad + R - 16} q-9 16 0 32`} fill="none" stroke="var(--rule-strong)" strokeWidth={1.5} />
      <path d={`M${pad + 2 * R + 1} ${pad + R - 16} q9 16 0 32`} fill="none" stroke="var(--rule-strong)" strokeWidth={1.5} />
      <line x1={pad + R} y1={pad + 4} x2={pad + R} y2={pad + 2 * R - 4} stroke="var(--grid)" />
      <line x1={pad + 4} y1={pad + R} x2={pad + 2 * R - 4} y2={pad + R} stroke="var(--grid)" />
      {channels.map((ch) => {
        const [x, y] = xy(ch), q = quality[ch], sel = selected === ch;
        const label = `${ch}: ${q ? WORD[q] : "no data"}${values?.[ch] ? `, ${values[ch]}` : ""}`;
        return (
          <g key={ch} role={onSelect ? "button" : undefined} tabIndex={onSelect ? 0 : undefined} aria-label={label}
            aria-pressed={onSelect ? sel : undefined} style={{ cursor: onSelect ? "pointer" : "default" }}
            onClick={() => onSelect?.(ch)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(ch); } }}>
            <title>{label}</title>
            {sel && <circle cx={x} cy={y} r={r + 4} fill="none" stroke="var(--accent)" strokeWidth={2} />}
            <circle cx={x} cy={y} r={r} fill={q ? FILL[q] : "var(--surface)"} stroke="var(--rule-strong)" strokeWidth={q ? 0 : 1} />
            {/* state shape on the rim (cross = bad, half ring = check), name inside, value below */}
            {q === "bad" && <path d={`M${x + r - 5} ${y - r - 1}l6 6M${x + r + 1} ${y - r - 1}l-6 6`} stroke="var(--signal)" strokeWidth={2} />}
            {q === "check" && <circle cx={x} cy={y} r={r + 2} fill="none" stroke="var(--check)" strokeWidth={1.5} strokeDasharray="3 3" />}
            {!compact && <text x={x} y={y + 0.5} textAnchor="middle" dominantBaseline="middle" fontSize={8.5} fontWeight={600}
              fill={q ? "#fff" : "var(--text)"}>{ch}</text>}
            {!compact && values?.[ch] && <text x={x} y={y + r + 9} textAnchor="middle" fontSize={8} fill="var(--text-muted)">{values[ch]}</text>}
          </g>
        );
      })}
    </svg>
  );
}
