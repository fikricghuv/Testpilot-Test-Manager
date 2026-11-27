"use client";

import Link from "next/link";
import { IconBrain, IconTrendingUp, IconTrendingDown, IconFlame, IconEyeOff, IconAlertCircle, IconBolt } from "@tabler/icons-react";
import type { PerformanceProjectReport, ReportsOverview } from "@/lib/api";
import { TrendLineChart } from "./charts";
import { LoadingBlock } from "./shared";

function SuiteHealthBars({ rows }: { rows: ReportsOverview["suiteHealth"] }) {
  return (
    <div className="space-y-3">
      {rows.map((s) => (
        <div key={s.suiteName}>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[12px] text-[var(--muted)]">{s.suiteName}</span>
            <span
              className="font-mono text-[11px] font-medium"
              style={{ color: s.executed === 0 ? "var(--muted-soft)" : s.passedPct >= 70 ? "var(--status-pass-text)" : "var(--status-blocked-text)" }}
            >
              {s.executed === 0 ? "Not run" : `${s.passedPct}% pass`}
            </span>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
            {s.executed > 0 && (
              <>
                <div className="h-full" style={{ width: `${s.passedPct}%`, background: "var(--status-pass-dot)" }} />
                <div className="h-full" style={{ width: `${s.failedPct}%`, background: "var(--status-fail-dot)" }} />
                <div className="h-full" style={{ width: `${s.blockedPct}%`, background: "var(--status-blocked-dot)" }} />
              </>
            )}
          </div>
        </div>
      ))}
      {rows.length === 0 && <p className="py-4 text-center text-[13px] text-[var(--muted-soft)]">No suites yet</p>}
    </div>
  );
}

export function OverviewTab({
  projectId,
  overview,
  loading,
  performanceReport,
  onOpenPerformance,
}: {
  projectId?: string;
  overview: ReportsOverview | null;
  loading: boolean;
  performanceReport?: PerformanceProjectReport | null;
  onOpenPerformance?: () => void;
}) {
  if (loading) return <LoadingBlock label="Loading overview…" />;
  if (!overview) return <LoadingBlock label="No data available." />;

  const trendPositive = overview.trendDelta >= 0;
  const points = overview.passRateTrend.map((p) => p.passRate);
  const labels = overview.passRateTrend.map((p) => new Date(p.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }));

  return (
    <div className="fade-in">
      <div className="mb-4">
        <div className="mb-0.5 text-[15px] font-semibold text-[var(--foreground)]">Overview</div>
        <div className="text-[12px] text-[var(--muted-soft)]">Across all suites and runs</div>
      </div>

      <div className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <div className="mb-3.5 flex items-center justify-between">
            <h3 className="text-[13px] font-semibold text-[var(--foreground)]">Pass rate trend</h3>
            {overview.passRateTrend.filter((p) => p.passRate !== null).length >= 2 && (
              <span
                className="flex items-center gap-1 text-[12px] font-medium"
                style={{ color: trendPositive ? "var(--status-pass-text)" : "var(--status-fail-text)" }}
              >
                {trendPositive ? <IconTrendingUp size={14} stroke={1.75} /> : <IconTrendingDown size={14} stroke={1.75} />}
                {trendPositive ? "+" : ""}{overview.trendDelta}%
              </span>
            )}
          </div>
          <TrendLineChart points={points} labels={labels} color="var(--status-pass-dot)" />
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <h3 className="mb-3.5 text-[13px] font-semibold text-[var(--foreground)]">Suite health</h3>
          <SuiteHealthBars rows={overview.suiteHealth} />
        </div>
      </div>

      {/* AI summary */}
      <div className="flex items-start gap-3.5 rounded-xl border border-[var(--ai-border)] bg-[var(--ai-soft)] p-5">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ai-surface)]">
          <IconBrain size={18} stroke={1.75} className="text-[var(--ai-primary)]" />
        </div>
        <div className="flex-1">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[13px] font-semibold text-[var(--foreground)]">AI summary</span>
            <span className="rounded-full bg-[var(--ai-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ai-primary)]">AI</span>
          </div>
          <p className="text-[12.5px] leading-relaxed text-[var(--muted)]">{overview.aiSummary}</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {overview.flakyCount > 0 && (
              <span className="flex items-center gap-1 rounded-full border border-[var(--status-fail-text)]/40 bg-[var(--status-fail-fill)] px-3 py-1 text-[11px] text-[var(--status-fail-text)]">
                <IconFlame size={12} stroke={1.75} /> {overview.flakyCount} flaky test{overview.flakyCount === 1 ? "" : "s"}
              </span>
            )}
            {overview.coverageGapCount > 0 && (
              <span className="flex items-center gap-1 rounded-full border border-[var(--status-blocked-text)]/40 bg-[var(--status-blocked-fill)] px-3 py-1 text-[11px] text-[var(--status-blocked-text)]">
                <IconEyeOff size={12} stroke={1.75} /> {overview.coverageGapCount} coverage gap{overview.coverageGapCount === 1 ? "" : "s"}
              </span>
            )}
            {overview.untestedP1Count > 0 && (
              <span className="flex items-center gap-1 rounded-full border border-[var(--info)]/40 bg-[var(--info-soft)] px-3 py-1 text-[11px] text-[var(--info-foreground)]">
                <IconAlertCircle size={12} stroke={1.75} /> {overview.untestedP1Count} untested P1{overview.untestedP1Count === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Performance Testing Summary Card */}
      <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <IconBolt size={16} stroke={1.75} className="text-[var(--brand-primary)]" />
            <h3 className="text-[13px] font-semibold text-[var(--foreground)]">Performance Testing (k6 · 30d)</h3>
          </div>
          <div className="flex items-center gap-3">
            {onOpenPerformance ? (
              <button
                type="button"
                onClick={onOpenPerformance}
                className="text-xs font-medium text-[var(--brand-primary)] hover:underline"
              >
                View full report
              </button>
            ) : null}
            {projectId ? (
              <Link
                href={`/projects/${projectId}/performance`}
                className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] hover:underline"
              >
                Manage scenarios
              </Link>
            ) : null}
          </div>
        </div>
        {performanceReport ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="rounded-lg bg-[var(--surface-secondary)]/50 px-3 py-2">
              <div className="text-[11px] text-[var(--muted-soft)]">Scenarios</div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-[var(--foreground)]">
                {performanceReport.kpis.totalScenarios}
              </div>
            </div>
            <div className="rounded-lg bg-[var(--surface-secondary)]/50 px-3 py-2">
              <div className="text-[11px] text-[var(--muted-soft)]">Total Runs</div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-[var(--foreground)]">
                {performanceReport.kpis.totalRuns}
              </div>
            </div>
            <div className="rounded-lg bg-[var(--surface-secondary)]/50 px-3 py-2">
              <div className="text-[11px] text-[var(--muted-soft)]">Threshold Pass</div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-[var(--foreground)]">
                {performanceReport.kpis.passRatePct !== null ? `${performanceReport.kpis.passRatePct}%` : "—"}
              </div>
            </div>
            <div className="rounded-lg bg-[var(--surface-secondary)]/50 px-3 py-2">
              <div className="text-[11px] text-[var(--muted-soft)]">Avg p95</div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-[var(--foreground)]">
                {performanceReport.kpis.avgP95Ms !== null ? `${performanceReport.kpis.avgP95Ms.toFixed(1)} ms` : "—"}
              </div>
            </div>
            <div className="rounded-lg bg-[var(--surface-secondary)]/50 px-3 py-2">
              <div className="text-[11px] text-[var(--muted-soft)]">Avg Error Rate</div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-[var(--foreground)]">
                {performanceReport.kpis.avgErrorRate !== null
                  ? `${(performanceReport.kpis.avgErrorRate * 100).toFixed(2)}%`
                  : "—"}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-[12px] text-[var(--muted-soft)]">No performance runs recorded in the last 30 days.</p>
        )}
      </div>
    </div>
  );
}
