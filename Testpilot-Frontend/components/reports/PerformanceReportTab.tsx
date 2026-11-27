"use client";

import Link from "next/link";
import type { PerformanceProjectReport, PerformanceReportRange } from "@/lib/api";
import { TrendLineChart } from "./charts";
import { LoadingBlock } from "./shared";

export function PerformanceReportTab({
  projectId,
  report,
  loading,
  range,
  onRangeChange,
}: {
  projectId: string;
  report: PerformanceProjectReport | null;
  loading: boolean;
  range: PerformanceReportRange;
  onRangeChange: (next: PerformanceReportRange) => void;
}) {
  if (loading && !report) return <LoadingBlock label="Loading performance report…" />;

  const kpis = report?.kpis;
  const trend = report?.trend ?? [];
  const scenarios = report?.scenarios ?? [];
  const slowest = report?.slowestEndpoints ?? [];

  const labels = trend.map((p) =>
    new Date(p.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  );

  return (
    <div className="fade-in space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="mb-0.5 text-[15px] font-semibold text-[var(--foreground)]">Performance Report</div>
          <div className="text-[12px] text-[var(--muted-soft)]">
            Aggregated Grafana k6 load, latency, and endpoint health across scenarios
          </div>
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)]/50 p-1">
          {(
            [
              ["7d", "7 Days"],
              ["30d", "30 Days"],
              ["all", "All Time"],
            ] as const
          ).map(([val, label]) => (
            <button
              key={val}
              type="button"
              onClick={() => onRangeChange(val)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                range === val
                  ? "bg-[var(--surface)] text-[var(--foreground)] shadow-sm"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 6-Card KPI Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="text-[11px] font-medium text-[var(--muted-soft)]">Scenarios</div>
          <div className="mt-1 font-mono text-xl font-semibold text-[var(--foreground)]">
            {kpis?.totalScenarios ?? 0}
          </div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="text-[11px] font-medium text-[var(--muted-soft)]">Total Runs</div>
          <div className="mt-1 font-mono text-xl font-semibold text-[var(--foreground)]">
            {kpis?.totalRuns ?? 0}
          </div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="text-[11px] font-medium text-[var(--muted-soft)]">Threshold Pass</div>
          <div className="mt-1 font-mono text-xl font-semibold text-[var(--foreground)]">
            {kpis?.passRatePct !== null && kpis?.passRatePct !== undefined ? `${kpis.passRatePct}%` : "—"}
          </div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="text-[11px] font-medium text-[var(--muted-soft)]">Avg p95 Latency</div>
          <div className="mt-1 font-mono text-xl font-semibold text-[var(--foreground)]">
            {kpis?.avgP95Ms !== null && kpis?.avgP95Ms !== undefined ? `${kpis.avgP95Ms.toFixed(1)} ms` : "—"}
          </div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="text-[11px] font-medium text-[var(--muted-soft)]">Avg RPS</div>
          <div className="mt-1 font-mono text-xl font-semibold text-[var(--foreground)]">
            {kpis?.avgRps !== null && kpis?.avgRps !== undefined ? `${kpis.avgRps.toFixed(1)}/s` : "—"}
          </div>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="text-[11px] font-medium text-[var(--muted-soft)]">Avg Error Rate</div>
          <div
            className={`mt-1 font-mono text-xl font-semibold ${
              (kpis?.avgErrorRate ?? 0) > 0 ? "text-[var(--error)]" : "text-[var(--foreground)]"
            }`}
          >
            {kpis?.avgErrorRate !== null && kpis?.avgErrorRate !== undefined
              ? `${(kpis.avgErrorRate * 100).toFixed(2)}%`
              : "—"}
          </div>
        </div>
      </div>

      {/* 2-Column Trend Charts */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <h3 className="mb-3 text-[13px] font-semibold text-[var(--foreground)]">p95 Latency Trend (ms)</h3>
          <TrendLineChart
            points={trend.map((p) => p.p95Ms)}
            labels={labels}
            color="var(--brand-primary)"
          />
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <h3 className="mb-3 text-[13px] font-semibold text-[var(--foreground)]">Throughput Trend (RPS)</h3>
          <TrendLineChart
            points={trend.map((p) => p.rps)}
            labels={labels}
            color="var(--status-pass-dot)"
          />
        </div>
      </div>

      {/* Per-Scenario Table */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h3 className="mb-3 text-[13px] font-semibold text-[var(--foreground)]">
          Performance by Scenario ({scenarios.length})
        </h3>
        {scenarios.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-[var(--muted-soft)]">
            No performance scenarios yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--border)] text-[var(--muted)]">
                <tr>
                  <th className="py-2 pr-3 font-medium">Scenario</th>
                  <th className="px-3 py-2 font-medium">Mode</th>
                  <th className="px-3 py-2 text-right font-medium">Runs</th>
                  <th className="px-3 py-2 text-right font-medium">Pass Rate</th>
                  <th className="px-3 py-2 text-right font-medium">Avg p95</th>
                  <th className="px-3 py-2 text-right font-medium">Avg RPS</th>
                  <th className="px-3 py-2 text-right font-medium">Avg Error</th>
                  <th className="py-2 pl-3 text-right font-medium">Latest</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {scenarios.map((s) => (
                  <tr key={s.id} className="hover:bg-[var(--surface-secondary)]/40">
                    <td className="py-2.5 pr-3">
                      <Link
                        href={`/projects/${projectId}/performance/${s.id}`}
                        className="font-medium text-[var(--foreground)] hover:underline"
                      >
                        {s.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 font-mono uppercase text-[var(--muted)]">{s.mode}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{s.totalRuns}</td>
                    <td className="px-3 py-2.5 text-right font-mono">
                      {s.passRatePct !== null ? `${s.passRatePct}%` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">
                      {s.avgP95Ms !== null ? `${s.avgP95Ms.toFixed(1)} ms` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">
                      {s.avgRps !== null ? `${s.avgRps.toFixed(1)}/s` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">
                      {s.avgErrorRate !== null ? `${(s.avgErrorRate * 100).toFixed(2)}%` : "—"}
                    </td>
                    <td className="py-2.5 pl-3 text-right font-mono uppercase text-[var(--muted)]">
                      {s.latestStatus ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Top Slowest Endpoints */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h3 className="mb-3 text-[13px] font-semibold text-[var(--foreground)]">
          Top Slowest Endpoints Across Project
        </h3>
        {slowest.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-[var(--muted-soft)]">
            No endpoint latency breakdown recorded in this period yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--border)] text-[var(--muted)]">
                <tr>
                  <th className="py-2 pr-3 font-medium">Method</th>
                  <th className="px-3 py-2 font-medium">Endpoint / URL</th>
                  <th className="px-3 py-2 font-medium">Scenario</th>
                  <th className="px-3 py-2 text-right font-medium">Reqs</th>
                  <th className="px-3 py-2 text-right font-medium">Error %</th>
                  <th className="px-3 py-2 text-right font-medium">Avg</th>
                  <th className="px-3 py-2 text-right font-medium">p95</th>
                  <th className="py-2 pl-3 text-right font-medium">Max</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {slowest.map((ep, idx) => (
                  <tr key={`${ep.testId}-${ep.method}-${ep.url}-${idx}`} className="hover:bg-[var(--surface-secondary)]/40">
                    <td className="py-2.5 pr-3 font-mono font-semibold">{ep.method}</td>
                    <td className="max-w-xs truncate px-3 py-2.5 font-mono text-[var(--foreground)]" title={ep.url}>
                      {ep.url}
                    </td>
                    <td className="px-3 py-2.5 text-[var(--muted)]">
                      <Link href={`/projects/${projectId}/performance/${ep.testId}`} className="hover:underline">
                        {ep.testName}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">{ep.totalCount}</td>
                    <td className={`px-3 py-2.5 text-right font-mono ${ep.failedCount > 0 ? "text-[var(--error)]" : ""}`}>
                      {(ep.errorRate * 100).toFixed(1)}%
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">{ep.avgMs.toFixed(1)} ms</td>
                    <td className="px-3 py-2.5 text-right font-mono font-semibold">{ep.p95Ms.toFixed(1)} ms</td>
                    <td className="py-2.5 pl-3 text-right font-mono">{ep.maxMs.toFixed(1)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
