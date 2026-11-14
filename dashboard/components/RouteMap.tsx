export type Station = { label: string; n: number };

// One track drawn as a transit line: each stop shows how many reached it. Stops nobody reached yet are hollow and dashed.
export function RouteLine({ color, stations, note }: { color: string; stations: Station[]; note?: string }) {
  const W = 1000;
  const pad = 46;
  const step = (W - pad * 2) / Math.max(1, stations.length - 1);
  const y = 42;
  const lastReached = stations.reduce((acc, s, i) => (s.n > 0 ? i : acc), -1);
  return (
    <div className="route-scroll">
      <svg className="route-svg" viewBox={`0 0 ${W} 86`} role="img" aria-label={stations.map((s) => `${s.label}: ${s.n}`).join(", ")}>
        {lastReached > 0 ? <line x1={pad} y1={y} x2={pad + step * lastReached} y2={y} stroke={color} strokeWidth="7" strokeLinecap="round" /> : null}
        {lastReached < stations.length - 1 ? (
          <line x1={pad + step * Math.max(0, lastReached)} y1={y} x2={W - pad} y2={y} stroke={color} strokeOpacity="0.35" strokeWidth="3" strokeDasharray="2 8" strokeLinecap="round" />
        ) : null}
        {stations.map((s, i) => {
          const x = pad + step * i;
          const reached = s.n > 0;
          return (
            <g key={s.label}>
              <circle cx={x} cy={y} r={reached ? 9 : 7} fill="var(--surface)" stroke={reached ? "var(--ink)" : color} strokeWidth={reached ? 3 : 2} strokeOpacity={reached ? 1 : 0.5} />
              <text x={x} y={y - 18} textAnchor="middle" fontSize="20" fontWeight="800" fill={reached ? "var(--ink)" : "var(--muted)"}>{s.n}</text>
              <text x={x} y={y + 31} textAnchor="middle" fontSize="15" fill="var(--ink-2)">{s.label}</text>
            </g>
          );
        })}
      </svg>
      {note ? <p className="small" style={{ margin: "0 0 4px", color: "var(--muted)", fontSize: 13 }}>{note}</p> : null}
    </div>
  );
}
