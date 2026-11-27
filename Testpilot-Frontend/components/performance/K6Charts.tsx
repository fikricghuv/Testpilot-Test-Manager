"use client";

import { useState } from "react";
import { Legend } from "@/components/reports/charts";

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  unit?: string;
  data: number[];
}

/**
 * Native Testpilot multi-series SVG line/area chart with gridlines, axis ticks,
 * and interactive hover crosshair — styled with Testpilot CSS tokens.
 */
export function K6TimeSeriesChart({
  labels,
  series,
  height = 200,
  emptyText = "Run the test to collect time-series metrics.",
}: {
  labels: string[];
  series: ChartSeries[];
  height?: number;
  emptyText?: string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const count = labels.length;

  if (count === 0 || series.every((s) => s.data.length === 0)) {
    return (
      <div className="flex h-[180px] items-center justify-center text-[13px] text-[var(--muted-soft)]">
        {emptyText}
      </div>
    );
  }

  const width = 620;
  const padL = 44;
  const padR = 14;
  const padT = 14;
  const padB = 24;
  const w = width - padL - padR;
  const h = height - padT - padB;

  const allValues = series.flatMap((s) => s.data);
  const rawMax = Math.max(...allValues, 1);
  const maxVal = rawMax * 1.1;

  const tx = (i: number) => padL + (count > 1 ? (i / (count - 1)) * w : w / 2);
  const ty = (v: number) => padT + h - (v / maxVal) * h;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((pct) => ({
    y: padT + h - pct * h,
    val: pct * maxVal,
  }));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
        {hoverIdx !== null && labels[hoverIdx] !== undefined ? (
          <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-[var(--foreground)]">
            <span className="text-[var(--muted)]">{labels[hoverIdx]}</span>
            {series.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.data[hoverIdx] !== undefined ? s.data[hoverIdx].toFixed(1) : "—"}
                {s.unit ?? ""}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full select-none"
        style={{ maxHeight: height }}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`k6-grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.2" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0.01" />
            </linearGradient>
          ))}
        </defs>

        {/* Horizontal gridlines + Y ticks */}
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={padL}
              y1={tick.y}
              x2={width - padR}
              y2={tick.y}
              stroke="var(--border)"
              strokeDasharray={i === 0 ? undefined : "3 3"}
              strokeWidth="1"
            />
            <text
              x={padL - 6}
              y={tick.y + 3}
              textAnchor="end"
              className="fill-[var(--muted-soft)]"
              style={{ fontSize: "9px", fontFamily: "var(--font-mono)" }}
            >
              {tick.val >= 100 ? Math.round(tick.val) : tick.val.toFixed(1)}
            </text>
          </g>
        ))}

        {/* Series areas & lines */}
        {series.map((s) => {
          if (s.data.length === 0) return null;
          const pts = s.data.map((v, i) => ({ x: tx(i), y: ty(v) }));
          const linePath = pts
            .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
            .join(" ");
          const areaPath = `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${(padT + h).toFixed(1)} L${pts[0].x.toFixed(1)},${(padT + h).toFixed(1)} Z`;

          return (
            <g key={s.key}>
              <path d={areaPath} fill={`url(#k6-grad-${s.key})`} />
              <path
                d={linePath}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          );
        })}

        {/* Hover crosshair */}
        {hoverIdx !== null ? (
          <g>
            <line
              x1={tx(hoverIdx)}
              y1={padT}
              x2={tx(hoverIdx)}
              y2={padT + h}
              stroke="var(--muted-soft)"
              strokeDasharray="2 2"
              strokeWidth="1"
            />
            {series.map((s) =>
              s.data[hoverIdx] !== undefined ? (
                <circle
                  key={s.key}
                  cx={tx(hoverIdx)}
                  cy={ty(s.data[hoverIdx])}
                  r="3.5"
                  fill={s.color}
                  stroke="var(--surface)"
                  strokeWidth="1.5"
                />
              ) : null
            )}
          </g>
        ) : null}

        {/* X-axis labels */}
        <text
          x={padL}
          y={height - 4}
          textAnchor="start"
          className="fill-[var(--muted-soft)]"
          style={{ fontSize: "9px", fontFamily: "var(--font-mono)" }}
        >
          {labels[0]}
        </text>
        {count > 2 ? (
          <text
            x={padL + w / 2}
            y={height - 4}
            textAnchor="middle"
            className="fill-[var(--muted-soft)]"
            style={{ fontSize: "9px", fontFamily: "var(--font-mono)" }}
          >
            {labels[Math.floor(count / 2)]}
          </text>
        ) : null}
        {count > 1 ? (
          <text
            x={width - padR}
            y={height - 4}
            textAnchor="end"
            className="fill-[var(--muted-soft)]"
            style={{ fontSize: "9px", fontFamily: "var(--font-mono)" }}
          >
            {labels[count - 1]}
          </text>
        ) : null}

        {/* Invisible hover columns */}
        {labels.map((_, i) => {
          const colW = count > 1 ? w / (count - 1) : w;
          return (
            <rect
              key={i}
              x={tx(i) - colW / 2}
              y={padT}
              width={colW}
              height={h}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(i)}
            />
          );
        })}
      </svg>
    </div>
  );
}

/**
 * Displays k6 HTTP request phase timings (Blocked, Connect, TLS, Sending, Waiting/TTFB, Receiving)
 * extracted from `summary_json.metrics`.
 */
export function HttpTimingsBreakdown({ summaryJson }: { summaryJson: Record<string, unknown> | null }) {
  const metrics = (summaryJson?.metrics ?? {}) as Record<string, { values?: Record<string, number>; avg?: number }>;

  const phases = [
    { key: "http_req_blocked", label: "Blocked", color: "#94a3b8" },
    { key: "http_req_connecting", label: "Connecting", color: "#38bdf8" },
    { key: "http_req_tls_handshaking", label: "TLS Handshake", color: "#818cf8" },
    { key: "http_req_sending", label: "Sending", color: "#34d399" },
    { key: "http_req_waiting", label: "Waiting (TTFB)", color: "var(--brand-primary)" },
    { key: "http_req_receiving", label: "Receiving", color: "#f59e0b" },
  ].map((p) => {
    const m = metrics[p.key];
    const avg = m?.values?.avg ?? m?.avg ?? 0;
    return { ...p, avgMs: typeof avg === "number" && Number.isFinite(avg) ? avg : 0 };
  });

  const total = phases.reduce((s, p) => s + p.avgMs, 0);

  if (total === 0) {
    return (
      <div className="py-6 text-center text-[13px] text-[var(--muted-soft)]">
        No HTTP phase timing metrics available.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex h-4 w-full overflow-hidden rounded-full bg-[var(--surface-secondary)]">
        {phases.map((p) => {
          const pct = (p.avgMs / total) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={p.key}
              style={{ width: `${pct}%`, background: p.color, minWidth: "3px" }}
              title={`${p.label}: ${p.avgMs.toFixed(2)} ms (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>

      <div className="space-y-2">
        {phases.map((p) => {
          const pct = total > 0 ? (p.avgMs / total) * 100 : 0;
          return (
            <div
              key={p.key}
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)]/40 px-3 py-1.5"
            >
              <span className="flex min-w-0 items-center gap-2 text-xs text-[var(--muted)]">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color }} />
                <span className="truncate">{p.label}</span>
              </span>
              <span className="shrink-0 font-mono text-xs font-medium text-[var(--foreground)]">
                {p.avgMs.toFixed(2)} ms
                <span className="ml-1.5 text-[10px] text-[var(--muted-soft)]">({pct.toFixed(0)}%)</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
