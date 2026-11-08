import { BANDS, type BandName, type BandPowerUpdate } from "../data/types";

export function meanBands(u: BandPowerUpdate | null, channels?: string[]): Record<BandName, number> | null {
  if (!u) return null;
  const rows = Object.entries(u.bands).filter(([ch]) => !channels || channels.includes(ch)).map(([, v]) => v);
  if (!rows.length) return null;
  return Object.fromEntries(BANDS.map((b) => [b.name, rows.reduce((a, r) => a + r[b.name], 0) / rows.length])) as Record<BandName, number>;
}

export const engagement = (m: Record<BandName, number>) => m.beta / Math.max(1e-9, m.alpha + m.theta);

interface Props {
  latest: BandPowerUpdate | null;
  history: number[];             // engagement index, one per second
  channels?: string[];
  title?: string;
}

export function BandPowerPanel({ latest, history, channels, title = "Band power" }: Props) {
  const m = meanBands(latest, channels);
  const total = m ? BANDS.reduce((a, b) => a + m[b.name], 0) : 0;
  const idx = m ? engagement(m) : null;
  const hist = history.slice(-120);
  const max = Math.max(0.6, ...hist);
  return (
    <section aria-label={title}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        <h3>{title}</h3>
        <span className="muted small">{channels ? channels.join(", ") : "mean of all channels"}, share of 1–30 Hz</span>
      </div>
      <dl style={{ display: "grid", gridTemplateColumns: "64px 1fr 48px", gap: "6px 10px", margin: 0, alignItems: "center" }}>
        {BANDS.map((b) => {
          const share = m && total ? m[b.name] / total : 0;
          return (
            <div key={b.name} style={{ display: "contents" }}>
              <dt style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span aria-hidden style={{ width: 10, height: 10, borderRadius: 2, background: `var(--band-${b.name})` }} />
                <span>{b.label}</span>
              </dt>
              <dd style={{ margin: 0, height: 10, background: "var(--grid)", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ width: `${share * 100}%`, height: "100%", background: `var(--band-${b.name})` }} />
              </dd>
              <dd className="num small" style={{ margin: 0, textAlign: "right" }}>{m ? `${Math.round(share * 100)}%` : "–"}</dd>
            </div>
          );
        })}
      </dl>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--rule)" }}>
        <div>
          <div className="small muted">Engagement index β/(α+θ)</div>
          <div className="num" style={{ fontSize: 20, fontWeight: 600 }}>{idx == null ? "–" : idx.toFixed(2)}</div>
        </div>
        <svg viewBox="0 0 120 32" preserveAspectRatio="none" style={{ flex: 1, height: 32 }} role="img"
          aria-label={`Engagement index over the last ${hist.length} seconds`}>
          <polyline fill="none" stroke="var(--ink)" strokeWidth={1.2} vectorEffect="non-scaling-stroke"
            points={hist.map((v, i) => `${(i / Math.max(1, hist.length - 1)) * 120},${32 - (v / max) * 30}`).join(" ")} />
        </svg>
      </div>
    </section>
  );
}
