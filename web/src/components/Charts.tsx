import { useLayoutEffect, useRef, useState } from "react";

/** Container width in CSS pixels, so the SVG is drawn 1:1 and its text never scales with the card. */
function useWidth<T extends HTMLElement>(fallback = 560) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export interface LineSeries {
  name: string;
  color: string; // CSS var reference, e.g. "var(--series-1)"
  values: number[]; // aligned with xs
}

const BASE_PAD = { top: 12, right: 150, bottom: 34, left: 40 };
const fmt = (v: number) => v.toFixed(2);

/** Multi-series line chart over a categorical x axis with 0–1 values (recall@k). */
export function LineChart({ xs, xLabel, series, height = 260 }: { xs: string[]; xLabel: string; series: LineSeries[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [wrapRef, W] = useWidth<HTMLDivElement>();
  // End labels need room on the right; on narrow screens show only the value there.
  const compact = W < 520;
  const PAD = { ...BASE_PAD, right: compact ? 44 : BASE_PAD.right };
  const innerW = W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (xs.length === 1 ? innerW / 2 : (i / (xs.length - 1)) * innerW);
  const lo = Math.max(0, Math.floor(Math.min(...series.flatMap((s) => s.values)) * 10) / 10 - 0.1);
  const y = (v: number) => PAD.top + innerH - ((v - lo) / (1 - lo)) * innerH;
  const ticks = Array.from({ length: Math.round((1 - lo) * 10) + 1 }, (_, i) => +(lo + i * 0.1).toFixed(1)).filter((_, i, a) => a.length <= 6 || i % 2 === 0);

  // End labels: sort by final value and nudge apart so they never overlap.
  const ends = series
    .map((s) => ({ s, y: y(s.values[s.values.length - 1]) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;

  function onMove(e: React.PointerEvent) {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    xs.forEach((_, i) => {
      if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    });
    setHover(best);
  }

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <Legend items={series.map((s) => ({ name: s.name, color: s.color, kind: "line" }))} />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        role="img"
        aria-label={`Line chart of ${series.map((s) => s.name).join(", ")} by ${xLabel}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + innerW} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--text-muted)">
              {t.toFixed(1)}
            </text>
          </g>
        ))}
        {xs.map((label, i) => (
          <text key={label} x={x(i)} y={height - 14} textAnchor="middle" fontSize={11.5} fill="var(--text-secondary)">
            {label}
          </text>
        ))}
        <text x={PAD.left + innerW / 2} y={height - 1} textAnchor="middle" fontSize={11} fill="var(--text-muted)">
          {xLabel}
        </text>
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} stroke="var(--text-muted)" strokeWidth={1} />}
        {series.map((s) => (
          <g key={s.name}>
            <polyline
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
            />
            {s.values.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 5 : 4} fill={s.color} stroke="var(--surface-1)" strokeWidth={2} />
            ))}
          </g>
        ))}
        {ends.map(({ s, y: ly }) => (
          <text key={s.name} x={PAD.left + innerW + 10} y={ly} dy="0.32em" fontSize={11.5} fill="var(--text-secondary)">
            {compact ? fmt(s.values[s.values.length - 1]) : `${s.name} ${fmt(s.values[s.values.length - 1])}`}
          </text>
        ))}
        <rect x={PAD.left - 20} y={PAD.top} width={innerW + 40} height={innerH} fill="transparent" />
      </svg>
      {hover !== null && (
        <div
          className="tooltip"
          style={{ left: `${(x(hover) / W) * 100}%`, top: 36, transform: x(hover) > W * 0.6 ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}
        >
          <div className="t-head">
            {xLabel} {xs[hover]}
          </div>
          {[...series]
            .sort((a, b) => b.values[hover] - a.values[hover])
            .map((s) => (
              <div key={s.name} className="t-row">
                <LineKey color={s.color} />
                <strong>{fmt(s.values[hover])}</strong>
                <span className="muted">{s.name}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/** Single-series column chart (one hue; title names the series, so no legend box). */
export function ColumnChart({ labels, values, valueLabel, height = 240 }: { labels: string[]; values: number[]; valueLabel: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [wrapRef, W] = useWidth<HTMLDivElement>();
  const pad = { top: 22, right: 12, bottom: 30, left: 40 };
  const innerW = W - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const band = innerW / labels.length;
  const barW = Math.min(24, band * 0.5);
  const lo = Math.max(0, Math.floor(Math.min(...values) * 10) / 10 - 0.1);
  const y = (v: number) => pad.top + innerH - ((v - lo) / (1 - lo)) * innerH;
  const ticks = Array.from({ length: Math.round((1 - lo) * 10) + 1 }, (_, i) => +(lo + i * 0.1).toFixed(1)).filter((_, i, a) => a.length <= 6 || i % 2 === 0);
  const best = values.indexOf(Math.max(...values));

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`Column chart of ${valueLabel}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={pad.left + innerW} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--text-muted)">
              {t.toFixed(1)}
            </text>
          </g>
        ))}
        {values.map((v, i) => {
          const cx = pad.left + band * i + band / 2;
          const top = y(v);
          const h = pad.top + innerH - top;
          const r = Math.min(4, h);
          // Rounded data-end, square at the baseline.
          const d = `M${cx - barW / 2},${pad.top + innerH} V${top + r} Q${cx - barW / 2},${top} ${cx - barW / 2 + r},${top} H${cx + barW / 2 - r} Q${cx + barW / 2},${top} ${cx + barW / 2},${top + r} V${pad.top + innerH} Z`;
          return (
            <g key={labels[i]} tabIndex={0} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
              <rect x={cx - band / 2} y={pad.top} width={band} height={innerH} fill="transparent" />
              <path d={d} fill="var(--series-1)" opacity={hover === null || hover === i ? 1 : 0.55} />
              {i === best && (
                <text x={cx} y={top - 6} textAnchor="middle" fontSize={11.5} fontWeight={600} fill="var(--text-primary)">
                  {fmt(v)}
                </text>
              )}
              <text x={cx} y={height - 12} textAnchor="middle" fontSize={11.5} fill="var(--text-secondary)">
                {labels[i]}
              </text>
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: `${((pad.left + band * hover + band / 2) / W) * 100}%`, top: 0, transform: "translateX(-50%)" }}>
          <div className="t-head">{labels[hover]}</div>
          <div className="t-row">
            <strong>{fmt(values[hover])}</strong>
            <span className="muted">{valueLabel}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { name: string; color: string; kind: "line" | "rect" }[] }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.name} className="legend-key">
          {it.kind === "line" ? <LineKey color={it.color} /> : <span style={{ width: 10, height: 10, borderRadius: 2, background: it.color }} />}
          {it.name}
        </span>
      ))}
    </div>
  );
}

function LineKey({ color }: { color: string }) {
  return (
    <svg width="16" height="8" aria-hidden>
      <line x1="1" x2="15" y1="4" y2="4" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}
