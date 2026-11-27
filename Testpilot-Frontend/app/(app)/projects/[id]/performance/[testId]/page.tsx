"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "@/lib/routeParams";
import {
  IconCheck,
  IconDownload,
  IconLoader2,
  IconPlayerPlay,
  IconPlayerStop,
  IconSparkles,
  IconTerminal2,
  IconX,
} from "@tabler/icons-react";
import {
  cancelPerformanceRun,
  downloadPerformanceRunPdf,
  getPerformanceTest,
  triggerPerformanceRun,
  updatePerformanceTest,
  zyraAnalyzePerformance,
  type PerformanceFlowStep,
  type PerformanceHttpMethod,
  type PerformanceRunRecord,
  type PerformanceRunStatus,
  type PerformanceTestMode,
  type PerformanceTestRecord,
  type ZyraPerformanceInsightsResult,
} from "@/lib/api";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ConfirmModal,
  Field,
  FieldLabel,
  Input,
  PageLoader,
  Select,
  StatusChip,
  Textarea,
} from "@/components/ui";
import { Breadcrumbs, ListWorkspaceLayout, PageHeader } from "@/components/workflows";
import { useProjectData } from "@/components/project/ProjectDataProvider";
import { DonutChart, TrendLineChart } from "@/components/reports/charts";
import { HttpTimingsBreakdown, K6TimeSeriesChart } from "@/components/performance/K6Charts";
import { LoadProfileEditor, type LoadProfileValue } from "@/components/performance/LoadProfileEditor";

function statusTone(status: PerformanceRunStatus): "neutral" | "info" | "success" | "error" | "warning" {
  switch (status) {
    case "passed":
      return "success";
    case "failed":
    case "error":
      return "error";
    case "running":
    case "queued":
      return "info";
    case "cancelled":
      return "warning";
    default:
      return "neutral";
  }
}

interface ExtractedThreshold {
  metric: string;
  expression: string;
  ok: boolean;
}

function extractThresholds(summaryJson: Record<string, unknown> | null): ExtractedThreshold[] {
  if (!summaryJson || typeof summaryJson !== "object") return [];
  const metrics = summaryJson.metrics as Record<string, Record<string, unknown>> | undefined;
  if (!metrics) return [];

  const list: ExtractedThreshold[] = [];
  for (const [metricName, metricObj] of Object.entries(metrics)) {
    const thMap = metricObj?.thresholds as Record<string, { ok?: boolean } | boolean> | undefined;
    if (!thMap || typeof thMap !== "object") continue;
    for (const [expression, res] of Object.entries(thMap)) {
      // k6 boolean threshold in summary-export means `crossed` (false = PASS, true = FAIL)
      const ok = typeof res === "boolean" ? !res : Boolean(res?.ok);
      list.push({ metric: metricName, expression, ok });
    }
  }
  return list;
}

function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function PerformanceTestDetailPage() {
  const { id: projectId, testId } = useParams<{ id: string; testId: string }>();
  const { project } = useProjectData();

  const [test, setTest] = useState<PerformanceTestRecord | null>(null);
  const [runs, setRuns] = useState<PerformanceRunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"results" | "config">("results");
  const [dashboardView, setDashboardView] = useState<"overview" | "timings" | "summary">("overview");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [analyzingZyra, setAnalyzingZyra] = useState(false);
  const [zyraInsights, setZyraInsights] = useState<ZyraPerformanceInsightsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAnalyzeWithZyra = async (runId?: string) => {
    if (!projectId || !testId) return;
    setAnalyzingZyra(true);
    setError(null);
    try {
      const res = await zyraAnalyzePerformance(projectId, { performanceTestId: testId, runId });
      setZyraInsights(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Zyra failed to analyze performance run.");
    } finally {
      setAnalyzingZyra(false);
    }
  };
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  // Editable state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<PerformanceTestMode>("builder");
  const [targetUrl, setTargetUrl] = useState("");
  const [method, setMethod] = useState<PerformanceHttpMethod>("GET");
  const [loadConfig, setLoadConfig] = useState<LoadProfileValue>({
    loadProfile: "fixed",
    vus: 10,
    durationSec: 15,
    targetRps: 10,
    stages: [],
  });
  const [p95ThresholdMs, setP95ThresholdMs] = useState("500");
  const [errorRateThresholdPct, setErrorRateThresholdPct] = useState("1");
  const [requestBody, setRequestBody] = useState("");
  const [flowSteps, setFlowSteps] = useState<PerformanceFlowStep[]>([]);
  const [deleteStepIdx, setDeleteStepIdx] = useState<number | null>(null);
  const [scriptContent, setScriptContent] = useState("");

  const syncForm = useCallback((record: PerformanceTestRecord) => {
    setName(record.name);
    setDescription(record.description ?? "");
    setMode(record.mode);
    setScriptContent(record.scriptContent);
    if (record.builderConfig) {
      setTargetUrl(record.builderConfig.targetUrl ?? "");
      setMethod(record.builderConfig.method ?? "GET");
      setLoadConfig({
        loadProfile:
          record.builderConfig.loadProfile ??
          (record.builderConfig.stages?.length ? "ramping" : "fixed"),
        vus: record.builderConfig.vus ?? 10,
        durationSec: record.builderConfig.durationSec ?? 15,
        targetRps: record.builderConfig.targetRps ?? 10,
        stages: record.builderConfig.stages ?? [],
      });
      setP95ThresholdMs(
        record.builderConfig.p95ThresholdMs !== null && record.builderConfig.p95ThresholdMs !== undefined
          ? String(record.builderConfig.p95ThresholdMs)
          : ""
      );
      setErrorRateThresholdPct(
        record.builderConfig.errorRateThresholdPct !== null &&
          record.builderConfig.errorRateThresholdPct !== undefined
          ? String(record.builderConfig.errorRateThresholdPct)
          : ""
      );
      setRequestBody(record.builderConfig.body ?? "");
    }
    if (record.flowConfig) {
      setLoadConfig({
        loadProfile:
          record.flowConfig.loadProfile ??
          (record.flowConfig.stages?.length ? "ramping" : "fixed"),
        vus: record.flowConfig.vus ?? 10,
        durationSec: record.flowConfig.durationSec ?? 30,
        targetRps: record.flowConfig.targetRps ?? 10,
        stages: record.flowConfig.stages ?? [],
      });
      setP95ThresholdMs(
        record.flowConfig.p95ThresholdMs !== null && record.flowConfig.p95ThresholdMs !== undefined
          ? String(record.flowConfig.p95ThresholdMs)
          : ""
      );
      setErrorRateThresholdPct(
        record.flowConfig.errorRateThresholdPct !== null &&
          record.flowConfig.errorRateThresholdPct !== undefined
          ? String(record.flowConfig.errorRateThresholdPct)
          : ""
      );
      setFlowSteps(record.flowConfig.steps ?? []);
    }
  }, []);

  const loadDetail = useCallback(
    async (preserveForm = false) => {
      if (!projectId || !testId) return;
      try {
        const res = await getPerformanceTest(projectId, testId);
        setTest(res.test);
        setRuns(res.runs);
        if (!preserveForm) {
          syncForm(res.test);
        }
        setSelectedRunId((prev) => prev ?? res.runs[0]?.id ?? null);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load performance test.");
      } finally {
        setLoading(false);
      }
    },
    [projectId, testId, syncForm]
  );

  useEffect(() => {
    void loadDetail(false);
  }, [loadDetail]);

  const hasActiveRun = useMemo(
    () => runs.some((r) => r.status === "queued" || r.status === "running"),
    [runs]
  );

  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = setInterval(() => {
      void loadDetail(true);
    }, 2000);
    return () => clearInterval(timer);
  }, [hasActiveRun, loadDetail]);

  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId]
  );

  const thresholds = useMemo(
    () => extractThresholds(selectedRun?.summaryJson ?? null),
    [selectedRun]
  );

  const effectiveErrorRate = useMemo(() => {
    if (selectedRun?.errorRate !== null && selectedRun?.errorRate !== undefined) {
      return selectedRun.errorRate;
    }
    const metrics = (selectedRun?.summaryJson?.metrics ?? {}) as Record<
      string,
      { value?: number; values?: { rate?: number } }
    >;
    const raw = metrics.http_req_failed?.values?.rate ?? metrics.http_req_failed?.value;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  }, [selectedRun]);

  const dataTransfer = useMemo(() => {
    const metrics = (selectedRun?.summaryJson?.metrics ?? {}) as Record<
      string,
      { values?: { count?: number }; count?: number }
    >;
    const received = metrics.data_received?.values?.count ?? metrics.data_received?.count ?? null;
    const sent = metrics.data_sent?.values?.count ?? metrics.data_sent?.count ?? null;
    return { received, sent };
  }, [selectedRun]);

  const iterationStats = useMemo(() => {
    const metrics = (selectedRun?.summaryJson?.metrics ?? {}) as Record<
      string,
      { count?: number; rate?: number; avg?: number; p95?: number; "p(95)"?: number; values?: Record<string, number> }
    >;
    const iters = metrics.iterations;
    const iterDur = metrics.iteration_duration;
    return {
      count: iters?.values?.count ?? iters?.count ?? null,
      rate: iters?.values?.rate ?? iters?.rate ?? null,
      avgMs: iterDur?.values?.avg ?? iterDur?.avg ?? null,
      p95Ms: iterDur?.values?.["p(95)"] ?? iterDur?.["p(95)"] ?? null,
    };
  }, [selectedRun]);

  const historicalChronological = useMemo(() => [...runs].reverse(), [runs]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !testId) return;
    setSaving(true);
    setError(null);
    setSaveNotice(null);

    try {
      const res = await updatePerformanceTest(projectId, testId, {
        name: name.trim(),
        description: description.trim() || null,
        mode,
        builderConfig:
          mode === "builder"
            ? {
                targetUrl: targetUrl.trim(),
                method,
                loadProfile: loadConfig.loadProfile,
                vus: loadConfig.vus,
                durationSec: loadConfig.durationSec,
                targetRps: loadConfig.loadProfile === "constant-arrival-rate" ? loadConfig.targetRps : null,
                stages: loadConfig.loadProfile === "ramping" ? loadConfig.stages : undefined,
                p95ThresholdMs: p95ThresholdMs ? Number(p95ThresholdMs) : null,
                errorRateThresholdPct: errorRateThresholdPct ? Number(errorRateThresholdPct) : null,
                body: requestBody.trim() || null,
                expectedStatus: 200,
                sleepSec: 1,
              }
            : null,
        flowConfig:
          mode === "flow"
            ? {
                loadProfile: loadConfig.loadProfile,
                vus: loadConfig.vus,
                durationSec: loadConfig.durationSec,
                targetRps: loadConfig.loadProfile === "constant-arrival-rate" ? loadConfig.targetRps : null,
                stages: loadConfig.loadProfile === "ramping" ? loadConfig.stages : undefined,
                p95ThresholdMs: p95ThresholdMs ? Number(p95ThresholdMs) : null,
                errorRateThresholdPct: errorRateThresholdPct ? Number(errorRateThresholdPct) : null,
                steps: flowSteps,
              }
            : null,
        scriptContent: mode === "script" ? scriptContent : null,
      });
      setTest(res.test);
      syncForm(res.test);
      setSaveNotice("Configuration saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save configuration.");
    } finally {
      setSaving(false);
    }
  };

  const handleTriggerRun = async () => {
    if (!projectId || !testId) return;
    setTriggering(true);
    setError(null);
    try {
      const res = await triggerPerformanceRun(projectId, testId);
      setSelectedRunId(res.run.id);
      setActiveTab("results");
      await loadDetail(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start k6 run.");
    } finally {
      setTriggering(false);
    }
  };

  const handleCancelRun = async (runId: string) => {
    if (!projectId || !testId) return;
    try {
      await cancelPerformanceRun(projectId, testId, runId);
      await loadDetail(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel run.");
    }
  };

  const handleDownloadPdf = async (runId: string) => {
    if (!projectId || !testId || !test) return;
    setDownloadingPdf(true);
    setError(null);
    try {
      const slug = test.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "performance";
      await downloadPerformanceRunPdf(projectId, testId, runId, `${slug}-k6-report.pdf`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to download PDF report.");
    } finally {
      setDownloadingPdf(false);
    }
  };

  if (loading) {
    return <PageLoader label="Loading performance scenario..." />;
  }

  if (!test) {
    return (
      <ListWorkspaceLayout
        header={
          <PageHeader
            breadcrumb={
              <Breadcrumbs
                items={[
                  { label: typeof project?.name === "string" ? project.name : "Project", href: `/projects/${projectId}` },
                  { label: "Performance", href: `/projects/${projectId}/performance` },
                  { label: "Not found" },
                ]}
              />
            }
            title="Performance Test Not Found"
          />
        }
      >
        <div className="text-sm text-[var(--muted)]">{error ?? "Scenario does not exist."}</div>
      </ListWorkspaceLayout>
    );
  }

  const ts = selectedRun?.timeseriesJson ?? [];
  const hasTimeseries = ts.length > 1;
  const checksPassed = selectedRun?.checksPassed ?? 0;
  const checksFailed = selectedRun?.checksFailed ?? 0;
  const totalChecks = checksPassed + checksFailed;
  const checkPassPct = totalChecks > 0 ? Math.round((checksPassed / totalChecks) * 100) : null;

  return (
    <ListWorkspaceLayout
      header={
        <PageHeader
          breadcrumb={
            <Breadcrumbs
              items={[
                { label: typeof project?.name === "string" ? project.name : "Project", href: `/projects/${projectId}` },
                { label: "Performance", href: `/projects/${projectId}/performance` },
                { label: test.name },
              ]}
            />
          }
          title={
            <span className="flex flex-wrap items-center gap-2.5">
              <span>{test.name}</span>
              <span className="rounded-md border border-[var(--border)] bg-[var(--surface-secondary)] px-2 py-0.5 font-mono text-xs font-medium uppercase text-[var(--muted)]">
                {test.mode}
              </span>
              {selectedRun ? (
                <StatusChip tone={statusTone(selectedRun.status)}>{selectedRun.status}</StatusChip>
              ) : null}
            </span>
          }
          subtitle={test.description ?? "Grafana k6 load & threshold scenario"}
          actions={
            <div className="flex items-center gap-2">
              {selectedRun && selectedRun.status !== "queued" && selectedRun.status !== "running" ? (
                <>
                  <Button
                    variant="secondary"
                    disabled={analyzingZyra}
                    onClick={() => void handleAnalyzeWithZyra(selectedRun.id)}
                  >
                    {analyzingZyra ? (
                      <IconLoader2 size={16} className="animate-spin" />
                    ) : (
                      <IconSparkles size={16} />
                    )}
                    Analyze with Zyra
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={downloadingPdf}
                    onClick={() => void handleDownloadPdf(selectedRun.id)}
                  >
                    {downloadingPdf ? (
                      <IconLoader2 size={16} className="animate-spin" />
                    ) : (
                      <IconDownload size={16} />
                    )}
                    Download PDF
                  </Button>
                </>
              ) : null}
              {selectedRun && (selectedRun.status === "queued" || selectedRun.status === "running") ? (
                <Button variant="secondary" onClick={() => void handleCancelRun(selectedRun.id)}>
                  <IconPlayerStop size={16} />
                  Cancel Run
                </Button>
              ) : null}
              <Button disabled={triggering || hasActiveRun} onClick={() => void handleTriggerRun()}>
                {triggering || hasActiveRun ? (
                  <IconLoader2 size={16} className="animate-spin" />
                ) : (
                  <IconPlayerPlay size={16} />
                )}
                {hasActiveRun ? "Running..." : "Run Test"}
              </Button>
            </div>
          }
        />
      }
    >
      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {zyraInsights ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <IconSparkles size={16} className="text-[var(--brand-primary)]" />
              <CardTitle>Zyra Performance Insights</CardTitle>
              <StatusChip tone={zyraInsights.healthVerdict === "healthy" ? "success" : "error"}>
                {zyraInsights.healthVerdict.replace(/_/g, " ")}
              </StatusChip>
            </div>
            <button
              type="button"
              onClick={() => setZyraInsights(null)}
              className="text-[var(--muted)] hover:text-[var(--foreground)]"
              title="Dismiss"
            >
              <IconX size={16} />
            </button>
          </CardHeader>
          <CardBody className="space-y-3 text-sm">
            <p className="text-[var(--foreground)]">{zyraInsights.summary}</p>
            {zyraInsights.bottlenecks.length > 0 && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Bottlenecks</div>
                <ul className="mt-1 list-disc pl-5 text-xs text-[var(--foreground-muted)] space-y-1">
                  {zyraInsights.bottlenecks.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            {zyraInsights.recommendations.length > 0 && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Recommendations</div>
                <ul className="mt-1 list-disc pl-5 text-xs text-[var(--foreground-muted)] space-y-1">
                  {zyraInsights.recommendations.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-muted)]/50 px-3 py-2 text-xs text-[var(--muted)]">
              Recommended next config: profile <strong>{zyraInsights.recommendedConfig.loadProfile}</strong>,{" "}
              <strong>{zyraInsights.recommendedConfig.vus} VUs</strong> for{" "}
              <strong>{zyraInsights.recommendedConfig.durationSec}s</strong> (p95 &lt;{" "}
              {zyraInsights.recommendedConfig.p95ThresholdMs}ms, max error rate{" "}
              {(zyraInsights.recommendedConfig.maxErrorRate * 100).toFixed(1)}%)
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* Sub-navigation Tabs + Run Selector */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] pb-px">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setActiveTab("results")}
            className={`border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              activeTab === "results"
                ? "border-[var(--brand-primary)] text-[var(--foreground)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
          >
            Dashboard & Runs ({runs.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("config")}
            className={`border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              activeTab === "config"
                ? "border-[var(--brand-primary)] text-[var(--foreground)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
          >
            Configuration & Script
          </button>
        </div>

        {activeTab === "results" && runs.length > 0 ? (
          <div className="flex items-center gap-2 pb-1.5">
            <span className="text-xs text-[var(--muted)]">Selected Run:</span>
            <Select
              className="h-8 w-64 text-xs"
              value={selectedRun?.id ?? ""}
              onChange={(e) => setSelectedRunId(e.target.value)}
            >
              {runs.map((r, idx) => (
                <option key={r.id} value={r.id}>
                  #{runs.length - idx} · {r.status.toUpperCase()} ·{" "}
                  {r.p95Ms !== null ? `p95 ${r.p95Ms.toFixed(0)}ms` : "pending"} ·{" "}
                  {new Date(r.createdAt).toLocaleTimeString()}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>

      {activeTab === "results" ? (
        selectedRun ? (
          <div className="space-y-5">
            {/* 6-Card KPI Overview Strip (k6 Web Dashboard style) */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Card>
                <CardBody className="p-4">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                    Total Requests
                  </div>
                  <div className="mt-1.5 font-mono text-2xl font-semibold text-[var(--foreground)]">
                    {selectedRun.totalRequests !== null ? selectedRun.totalRequests.toLocaleString() : "—"}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--muted-soft)]">
                    {selectedRun.vus ?? "—"} VUs · {selectedRun.durationSec ?? "—"}s
                  </div>
                </CardBody>
              </Card>

              <Card>
                <CardBody className="p-4">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                    Throughput
                  </div>
                  <div className="mt-1.5 font-mono text-2xl font-semibold text-[var(--foreground)]">
                    {selectedRun.rps !== null ? `${selectedRun.rps.toFixed(1)}` : "—"}
                    <span className="ml-1 text-xs font-normal text-[var(--muted)]">req/s</span>
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--muted-soft)]">
                    Avg across run
                  </div>
                </CardBody>
              </Card>

              <Card>
                <CardBody className="p-4">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                    p95 Latency
                  </div>
                  <div className="mt-1.5 font-mono text-2xl font-semibold text-[var(--foreground)]">
                    {selectedRun.p95Ms !== null ? `${selectedRun.p95Ms.toFixed(1)}` : "—"}
                    <span className="ml-1 text-xs font-normal text-[var(--muted)]">ms</span>
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--muted-soft)]">
                    Avg {selectedRun.avgMs !== null ? `${selectedRun.avgMs.toFixed(1)} ms` : "—"}
                  </div>
                </CardBody>
              </Card>

              <Card>
                <CardBody className="p-4">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                    Error Rate
                  </div>
                  <div
                    className={`mt-1.5 font-mono text-2xl font-semibold ${
                      (effectiveErrorRate ?? 0) > 0 ? "text-[var(--error)]" : "text-[var(--foreground)]"
                    }`}
                  >
                    {effectiveErrorRate !== null ? `${(effectiveErrorRate * 100).toFixed(2)}%` : "—"}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--muted-soft)]">
                    HTTP failed reqs
                  </div>
                </CardBody>
              </Card>

              <Card>
                <CardBody className="p-4">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                    Checks Pass
                  </div>
                  <div className="mt-1.5 font-mono text-2xl font-semibold text-[var(--foreground)]">
                    {checkPassPct !== null ? `${checkPassPct}%` : "—"}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--muted-soft)]">
                    {checksPassed} ok / {checksFailed} fail
                  </div>
                </CardBody>
              </Card>

              <Card>
                <CardBody className="p-4">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                    Data Transfer
                  </div>
                  <div className="mt-1.5 font-mono text-xl font-semibold text-[var(--foreground)]">
                    {formatBytes(dataTransfer.received)}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--muted-soft)]">
                    Sent {formatBytes(dataTransfer.sent)}
                  </div>
                </CardBody>
              </Card>
            </div>

            {selectedRun.errorMessage ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                {selectedRun.errorMessage}
              </div>
            ) : null}

            {/* k6 Web Dashboard Sub-View Switcher: Overview | Timings | Summary & Endpoints */}
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)]/50 p-1 w-fit">
              {(
                [
                  ["overview", "Overview"],
                  ["timings", "Timings"],
                  ["summary", "Endpoints & Summary"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setDashboardView(key)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    dashboardView === key
                      ? "bg-[var(--surface)] text-[var(--foreground)] shadow-sm"
                      : "text-[var(--muted)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {dashboardView === "overview" ? (
              <>
                {/* Primary Charts Row: Time-Series (or Run-to-Run Trend fallback) */}
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                  <Card className="p-5">
                    <CardHeader>
                      <CardTitle>
                        {hasTimeseries ? "Response Time Over Time (ms)" : "p95 Latency Trend Across Runs (ms)"}
                      </CardTitle>
                    </CardHeader>
                    <CardBody>
                      {hasTimeseries ? (
                        <K6TimeSeriesChart
                          labels={ts.map((p) => `${p.t}s`)}
                          series={[
                            {
                              key: "p95",
                              label: "p95",
                              color: "var(--brand-primary)",
                              unit: " ms",
                              data: ts.map((p) => p.p95Ms),
                            },
                            {
                              key: "p90",
                              label: "p90",
                              color: "#f59e0b",
                              unit: " ms",
                              data: ts.map((p) => p.p90Ms ?? p.p95Ms),
                            },
                            {
                              key: "avg",
                              label: "Avg",
                              color: "#38bdf8",
                              unit: " ms",
                              data: ts.map((p) => p.avgMs),
                            },
                          ]}
                        />
                      ) : (
                        <TrendLineChart
                          points={historicalChronological.map((r) => r.p95Ms)}
                          labels={historicalChronological.map((r) => new Date(r.createdAt).toLocaleTimeString())}
                          color="var(--brand-primary)"
                        />
                      )}
                    </CardBody>
                  </Card>

                  <Card className="p-5">
                    <CardHeader>
                      <CardTitle>
                        {hasTimeseries ? "Request Rate (RPS), Failures & VUs" : "Throughput Trend Across Runs (RPS)"}
                      </CardTitle>
                    </CardHeader>
                    <CardBody>
                      {hasTimeseries ? (
                        <K6TimeSeriesChart
                          labels={ts.map((p) => `${p.t}s`)}
                          series={[
                            {
                              key: "rps",
                              label: "Requests / sec",
                              color: "var(--success)",
                              unit: " rps",
                              data: ts.map((p) => p.rps),
                            },
                            {
                              key: "failedRps",
                              label: "Failed / sec",
                              color: "var(--error)",
                              unit: " /s",
                              data: ts.map((p) => p.failedRps ?? 0),
                            },
                            {
                              key: "vus",
                              label: "VUs",
                              color: "var(--warning)",
                              unit: " VUs",
                              data: ts.map((p) => p.vus),
                            },
                          ]}
                        />
                      ) : (
                        <TrendLineChart
                          points={historicalChronological.map((r) => r.rps)}
                          labels={historicalChronological.map((r) => new Date(r.createdAt).toLocaleTimeString())}
                          color="var(--success)"
                        />
                      )}
                    </CardBody>
                  </Card>
                </div>

                {/* Deep Dive Row: Latency Percentiles + HTTP Phase Timings + Checks Donut */}
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
                  <Card className="p-5 lg:col-span-5">
                    <CardHeader>
                      <CardTitle>Latency Distribution (ms)</CardTitle>
                    </CardHeader>
                    <CardBody className="space-y-3">
                      {[
                        { label: "Min", val: selectedRun.minMs, color: "#38bdf8" },
                        { label: "Median", val: selectedRun.medMs, color: "#34d399" },
                        { label: "Average", val: selectedRun.avgMs, color: "var(--brand-primary)" },
                        { label: "p90", val: selectedRun.p90Ms, color: "#f59e0b" },
                        { label: "p95", val: selectedRun.p95Ms, color: "#f97316" },
                        { label: "Max", val: selectedRun.maxMs, color: "var(--error)" },
                      ].map((item) => {
                        const maxVal = Math.max(selectedRun.maxMs ?? 0, selectedRun.p95Ms ?? 0, 1);
                        const pct = typeof item.val === "number" ? Math.min(100, (item.val / maxVal) * 100) : 0;
                        return (
                          <div key={item.label} className="flex items-center gap-3">
                            <span className="w-16 text-xs text-[var(--muted)]">{item.label}</span>
                            <div className="h-3 flex-1 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
                              <div
                                className="h-full rounded-full transition-[width] duration-300"
                                style={{ width: `${pct}%`, background: item.color, minWidth: item.val ? "6px" : "0px" }}
                              />
                            </div>
                            <span className="w-20 text-right font-mono text-xs font-medium text-[var(--foreground)]">
                              {typeof item.val === "number" ? `${item.val.toFixed(2)} ms` : "—"}
                            </span>
                          </div>
                        );
                      })}
                    </CardBody>
                  </Card>

                  <Card className="p-5 lg:col-span-4">
                    <CardHeader>
                      <CardTitle>HTTP Request Phase Timings</CardTitle>
                    </CardHeader>
                    <CardBody>
                      <HttpTimingsBreakdown summaryJson={selectedRun.summaryJson} />
                    </CardBody>
                  </Card>

                  <Card className="p-5 lg:col-span-3">
                    <CardHeader>
                      <CardTitle>Checks Summary</CardTitle>
                    </CardHeader>
                    <CardBody className="flex flex-col items-center justify-center gap-3">
                      <DonutChart
                        size={132}
                        centerLabel={checkPassPct !== null ? `${checkPassPct}%` : "—"}
                        centerSub="Passed"
                        data={[
                          { label: "Passed", value: checksPassed, color: "var(--status-pass-dot)" },
                          { label: "Failed", value: checksFailed, color: "var(--status-fail-dot)" },
                        ]}
                      />
                      <div className="flex items-center gap-4 text-xs text-[var(--muted)]">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full bg-[var(--status-pass-dot)]" />
                          {checksPassed} Passed
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full bg-[var(--status-fail-dot)]" />
                          {checksFailed} Failed
                        </span>
                      </div>
                    </CardBody>
                  </Card>
                </div>
              </>
            ) : dashboardView === "timings" ? (
              <>
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                  <Card className="p-5">
                    <CardHeader>
                      <CardTitle>HTTP Phase Timings Over Time (ms)</CardTitle>
                    </CardHeader>
                    <CardBody>
                      <K6TimeSeriesChart
                        labels={ts.map((p) => `${p.t}s`)}
                        series={[
                          {
                            key: "waiting",
                            label: "Waiting (TTFB)",
                            color: "var(--brand-primary)",
                            unit: " ms",
                            data: ts.map((p) => p.waitingMs ?? 0),
                          },
                          {
                            key: "connecting",
                            label: "Connecting",
                            color: "#38bdf8",
                            unit: " ms",
                            data: ts.map((p) => p.connectingMs ?? 0),
                          },
                          {
                            key: "tls",
                            label: "TLS Handshake",
                            color: "#818cf8",
                            unit: " ms",
                            data: ts.map((p) => p.tlsMs ?? 0),
                          },
                        ]}
                      />
                    </CardBody>
                  </Card>

                  <Card className="p-5">
                    <CardHeader>
                      <CardTitle>Latency Percentiles Over Time (ms)</CardTitle>
                    </CardHeader>
                    <CardBody>
                      <K6TimeSeriesChart
                        labels={ts.map((p) => `${p.t}s`)}
                        series={[
                          {
                            key: "p99",
                            label: "p99",
                            color: "var(--error)",
                            unit: " ms",
                            data: ts.map((p) => p.p99Ms ?? p.p95Ms),
                          },
                          {
                            key: "p95",
                            label: "p95",
                            color: "var(--brand-primary)",
                            unit: " ms",
                            data: ts.map((p) => p.p95Ms),
                          },
                          {
                            key: "med",
                            label: "Median",
                            color: "#34d399",
                            unit: " ms",
                            data: ts.map((p) => p.medMs ?? p.avgMs),
                          },
                        ]}
                      />
                    </CardBody>
                  </Card>
                </div>

                <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
                  <Card className="p-5 lg:col-span-6">
                    <CardHeader>
                      <CardTitle>HTTP Request Phase Breakdown (Avg)</CardTitle>
                    </CardHeader>
                    <CardBody>
                      <HttpTimingsBreakdown summaryJson={selectedRun.summaryJson} />
                    </CardBody>
                  </Card>

                  <Card className="p-5 lg:col-span-6">
                    <CardHeader>
                      <CardTitle>Iterations Summary</CardTitle>
                    </CardHeader>
                    <CardBody className="grid grid-cols-2 gap-3">
                      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)]/40 p-3">
                        <div className="text-xs text-[var(--muted)]">Total Iterations</div>
                        <div className="mt-1 font-mono text-lg font-semibold text-[var(--foreground)]">
                          {iterationStats.count !== null ? iterationStats.count.toLocaleString() : "—"}
                        </div>
                      </div>
                      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)]/40 p-3">
                        <div className="text-xs text-[var(--muted)]">Iterations / sec</div>
                        <div className="mt-1 font-mono text-lg font-semibold text-[var(--foreground)]">
                          {iterationStats.rate !== null ? `${iterationStats.rate.toFixed(2)}/s` : "—"}
                        </div>
                      </div>
                      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)]/40 p-3">
                        <div className="text-xs text-[var(--muted)]">Iteration Avg Duration</div>
                        <div className="mt-1 font-mono text-lg font-semibold text-[var(--foreground)]">
                          {iterationStats.avgMs !== null ? `${iterationStats.avgMs.toFixed(1)} ms` : "—"}
                        </div>
                      </div>
                      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)]/40 p-3">
                        <div className="text-xs text-[var(--muted)]">Iteration p95 Duration</div>
                        <div className="mt-1 font-mono text-lg font-semibold text-[var(--foreground)]">
                          {iterationStats.p95Ms !== null ? `${iterationStats.p95Ms.toFixed(1)} ms` : "—"}
                        </div>
                      </div>
                    </CardBody>
                  </Card>
                </div>
              </>
            ) : (
              <div className="space-y-5">
                {/* Per-Endpoint Breakdown Table */}
                <Card className="p-5">
                  <CardHeader>
                    <CardTitle>Endpoint / URL Breakdown</CardTitle>
                  </CardHeader>
                  <CardBody>
                    {(selectedRun.breakdownJson?.endpoints?.length ?? 0) === 0 ? (
                      <p className="py-4 text-center text-xs text-[var(--muted-soft)]">
                        Run a new test to capture per-endpoint latency and error breakdown.
                      </p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="border-b border-[var(--border)] bg-[var(--surface-secondary)] text-[var(--muted)]">
                            <tr>
                              <th className="px-3 py-2.5 font-medium">Method</th>
                              <th className="px-3 py-2.5 font-medium">Endpoint / URL</th>
                              <th className="px-3 py-2.5 text-right font-medium">Reqs</th>
                              <th className="px-3 py-2.5 text-right font-medium">Errors</th>
                              <th className="px-3 py-2.5 text-right font-medium">Avg</th>
                              <th className="px-3 py-2.5 text-right font-medium">Med</th>
                              <th className="px-3 py-2.5 text-right font-medium">p90</th>
                              <th className="px-3 py-2.5 text-right font-medium">p95</th>
                              <th className="px-3 py-2.5 text-right font-medium">Max</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[var(--border)]">
                            {selectedRun.breakdownJson?.endpoints.map((ep, idx) => (
                              <tr key={`${ep.method}-${ep.url}-${idx}`} className="hover:bg-[var(--surface-secondary)]/40">
                                <td className="px-3 py-2.5 font-mono font-semibold">{ep.method}</td>
                                <td className="max-w-sm truncate px-3 py-2.5 font-mono text-[var(--foreground)]" title={ep.url}>
                                  {ep.url}
                                </td>
                                <td className="px-3 py-2.5 text-right font-mono">{ep.count}</td>
                                <td className={`px-3 py-2.5 text-right font-mono ${ep.failed > 0 ? "text-[var(--error)]" : ""}`}>
                                  {ep.failed} ({(ep.errorRate * 100).toFixed(1)}%)
                                </td>
                                <td className="px-3 py-2.5 text-right font-mono">{ep.avgMs.toFixed(1)} ms</td>
                                <td className="px-3 py-2.5 text-right font-mono">{ep.medMs.toFixed(1)} ms</td>
                                <td className="px-3 py-2.5 text-right font-mono">{ep.p90Ms.toFixed(1)} ms</td>
                                <td className="px-3 py-2.5 text-right font-mono font-semibold">{ep.p95Ms.toFixed(1)} ms</td>
                                <td className="px-3 py-2.5 text-right font-mono">{ep.maxMs.toFixed(1)} ms</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardBody>
                </Card>

                {/* Status Codes + Checks Breakdown */}
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
                  <Card className="p-5 lg:col-span-5">
                    <CardHeader>
                      <CardTitle>HTTP Status Code Distribution</CardTitle>
                    </CardHeader>
                    <CardBody className="space-y-2.5">
                      {Object.keys(selectedRun.breakdownJson?.statusCodes ?? {}).length === 0 ? (
                        <p className="py-4 text-center text-xs text-[var(--muted-soft)]">
                          No status code breakdown available for this run.
                        </p>
                      ) : (
                        Object.entries(selectedRun.breakdownJson?.statusCodes ?? {})
                          .sort((a, b) => Number(a[0]) - Number(b[0]))
                          .map(([code, count]) => {
                            const num = Number(code);
                            const toneColor =
                              num >= 200 && num < 300
                                ? "var(--success)"
                                : num >= 400 || num === 0
                                ? "var(--error)"
                                : "var(--warning)";
                            return (
                              <div
                                key={code}
                                className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)]/40 px-3 py-2"
                              >
                                <span className="flex items-center gap-2 font-mono text-xs font-semibold text-[var(--foreground)]">
                                  <span className="h-2 w-2 rounded-full" style={{ background: toneColor }} />
                                  HTTP {code === "0" ? "0 (Connection/Timeout)" : code}
                                </span>
                                <span className="font-mono text-xs text-[var(--muted)]">{count.toLocaleString()} reqs</span>
                              </div>
                            );
                          })
                      )}
                    </CardBody>
                  </Card>

                  <Card className="p-5 lg:col-span-7">
                    <CardHeader>
                      <CardTitle>Checks Breakdown</CardTitle>
                    </CardHeader>
                    <CardBody>
                      {(selectedRun.breakdownJson?.checks?.length ?? 0) === 0 ? (
                        <p className="py-4 text-center text-xs text-[var(--muted-soft)]">
                          No individual check breakdown available for this run.
                        </p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead className="border-b border-[var(--border)] bg-[var(--surface-secondary)] text-[var(--muted)]">
                              <tr>
                                <th className="px-3 py-2 font-medium">Group</th>
                                <th className="px-3 py-2 font-medium">Check</th>
                                <th className="px-3 py-2 text-right font-medium">Passed</th>
                                <th className="px-3 py-2 text-right font-medium">Failed</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--border)]">
                              {selectedRun.breakdownJson?.checks.map((c, idx) => (
                                <tr key={`${c.group}-${c.name}-${idx}`}>
                                  <td className="px-3 py-2 text-[var(--muted)]">{c.group}</td>
                                  <td className="px-3 py-2 font-medium text-[var(--foreground)]">{c.name}</td>
                                  <td className="px-3 py-2 text-right font-mono text-emerald-600">{c.passes}</td>
                                  <td className={`px-3 py-2 text-right font-mono ${c.fails > 0 ? "text-red-600" : "text-[var(--muted)]"}`}>
                                    {c.fails}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </CardBody>
                  </Card>
                </div>
              </div>
            )}

            {/* Thresholds & Console Output */}
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
              {thresholds.length > 0 ? (
                <Card className="p-5 lg:col-span-5">
                  <CardHeader>
                    <CardTitle>k6 Thresholds</CardTitle>
                  </CardHeader>
                  <CardBody className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
                    {thresholds.map((t, i) => (
                      <div key={`${t.metric}-${i}`} className="flex items-center justify-between px-4 py-3 text-sm">
                        <span className="font-mono text-xs text-[var(--foreground)]">
                          {t.metric}: {t.expression}
                        </span>
                        {t.ok ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600">
                            <IconCheck size={14} /> Pass
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2.5 py-0.5 text-xs font-medium text-red-600">
                            <IconX size={14} /> Fail
                          </span>
                        )}
                      </div>
                    ))}
                  </CardBody>
                </Card>
              ) : null}

              <Card className={`p-5 ${thresholds.length > 0 ? "lg:col-span-7" : "lg:col-span-12"}`}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <IconTerminal2 size={16} />
                    k6 Console Output
                  </CardTitle>
                </CardHeader>
                <CardBody>
                  <pre className="max-h-72 overflow-auto rounded-lg bg-zinc-950 p-3.5 font-mono text-xs leading-relaxed text-zinc-100">
                    {selectedRun.stdout || selectedRun.stderr || "Waiting for k6 output..."}
                  </pre>
                </CardBody>
              </Card>
            </div>
          </div>
        ) : (
          <Card className="p-8 text-center text-sm text-[var(--muted)]">
            No runs yet. Click &ldquo;Run Test&rdquo; in the top right to execute this Grafana k6 scenario and populate the dashboard.
          </Card>
        )
      ) : (
        <Card className="p-6">
          <CardBody>
            <form onSubmit={handleSave} className="space-y-4">
              {saveNotice ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300">
                  {saveNotice}
                </div>
              ) : null}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel>Scenario Name</FieldLabel>
                  <Input required value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel>Authoring Mode</FieldLabel>
                  <Select value={mode} onChange={(e) => setMode(e.target.value as PerformanceTestMode)}>
                    <option value="builder">Single API Builder</option>
                    <option value="flow">Multi-Step Business Flow</option>
                    <option value="script">Custom k6 JavaScript</option>
                  </Select>
                </Field>
              </div>

              <Field>
                <FieldLabel>Description</FieldLabel>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} />
              </Field>

              {mode === "builder" ? (
                <div className="space-y-4 rounded-lg border border-[var(--border)] p-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
                    <Field>
                      <FieldLabel>Method</FieldLabel>
                      <Select value={method} onChange={(e) => setMethod(e.target.value as PerformanceHttpMethod)}>
                        <option value="GET">GET</option>
                        <option value="POST">POST</option>
                        <option value="PUT">PUT</option>
                        <option value="PATCH">PATCH</option>
                        <option value="DELETE">DELETE</option>
                      </Select>
                    </Field>
                    <Field className="sm:col-span-3">
                      <FieldLabel>Target URL</FieldLabel>
                      <Input required type="url" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} />
                    </Field>
                  </div>

                  <LoadProfileEditor value={loadConfig} onChange={setLoadConfig} />

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field>
                      <FieldLabel>p95 Threshold (ms)</FieldLabel>
                      <Input
                        type="number"
                        min={1}
                        value={p95ThresholdMs}
                        onChange={(e) => setP95ThresholdMs(e.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Max Error Rate (%)</FieldLabel>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step="0.1"
                        value={errorRateThresholdPct}
                        onChange={(e) => setErrorRateThresholdPct(e.target.value)}
                      />
                    </Field>
                  </div>

                  {method !== "GET" && method !== "DELETE" ? (
                    <Field>
                      <FieldLabel>Request Body (JSON/text)</FieldLabel>
                      <Textarea
                        rows={4}
                        className="font-mono text-xs"
                        value={requestBody}
                        onChange={(e) => setRequestBody(e.target.value)}
                      />
                    </Field>
                  ) : null}

                  <Field>
                    <FieldLabel>Generated k6 Script Preview (read-only in Builder mode)</FieldLabel>
                    <Textarea rows={10} readOnly className="bg-[var(--surface-secondary)] font-mono text-xs" value={scriptContent} />
                  </Field>
                </div>
              ) : mode === "flow" ? (
                <div className="space-y-4 rounded-lg border border-[var(--border)] p-4">
                  <LoadProfileEditor value={loadConfig} onChange={setLoadConfig} />

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field>
                      <FieldLabel>p95 Threshold (ms)</FieldLabel>
                      <Input
                        type="number"
                        min={1}
                        value={p95ThresholdMs}
                        onChange={(e) => setP95ThresholdMs(e.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Max Error Rate (%)</FieldLabel>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step="0.1"
                        value={errorRateThresholdPct}
                        onChange={(e) => setErrorRateThresholdPct(e.target.value)}
                      />
                    </Field>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Business Flow API Steps ({flowSteps.length})</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        setFlowSteps((prev) => [
                          ...prev,
                          {
                            id: `step-${Date.now()}`,
                            name: `Step ${prev.length + 1}`,
                            method: "GET",
                            url: "https://test.k6.io",
                            expectedStatus: 200,
                            sleepAfterSec: 0.5,
                            enabled: true,
                          },
                        ])
                      }
                    >
                      + Add API Step
                    </Button>
                  </div>

                  <div className="space-y-2">
                    {flowSteps.map((step, idx) => (
                      <div key={step.id} className="grid grid-cols-1 gap-2 rounded-lg border border-[var(--border)] p-3 sm:grid-cols-12">
                        <div className="flex items-center gap-2 sm:col-span-3">
                          <input
                            type="checkbox"
                            checked={step.enabled !== false}
                            onChange={(e) =>
                              setFlowSteps((prev) =>
                                prev.map((s, i) => (i === idx ? { ...s, enabled: e.target.checked } : s))
                              )
                            }
                          />
                          <Input
                            value={step.name}
                            onChange={(e) =>
                              setFlowSteps((prev) =>
                                prev.map((s, i) => (i === idx ? { ...s, name: e.target.value } : s))
                              )
                            }
                            placeholder="Step name"
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <Select
                            value={step.method}
                            onChange={(e) =>
                              setFlowSteps((prev) =>
                                prev.map((s, i) =>
                                  i === idx ? { ...s, method: e.target.value as PerformanceHttpMethod } : s
                                )
                              )
                            }
                          >
                            <option value="GET">GET</option>
                            <option value="POST">POST</option>
                            <option value="PUT">PUT</option>
                            <option value="PATCH">PATCH</option>
                            <option value="DELETE">DELETE</option>
                          </Select>
                        </div>
                        <div className="sm:col-span-5">
                          <Input
                            value={step.url}
                            onChange={(e) =>
                              setFlowSteps((prev) =>
                                prev.map((s, i) => (i === idx ? { ...s, url: e.target.value } : s))
                              )
                            }
                            placeholder="https://..."
                          />
                        </div>
                        <div className="flex items-center gap-1 sm:col-span-2">
                          <Input
                            type="number"
                            value={step.expectedStatus ?? 200}
                            onChange={(e) =>
                              setFlowSteps((prev) =>
                                prev.map((s, i) =>
                                  i === idx ? { ...s, expectedStatus: Number(e.target.value) || 200 } : s
                                )
                              )
                            }
                            title="Expected HTTP status"
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label="Delete API step"
                            onClick={() => setDeleteStepIdx(idx)}
                          >
                            <IconX size={14} />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <Field>
                    <FieldLabel>Generated k6 Flow Script Preview</FieldLabel>
                    <Textarea rows={12} readOnly className="bg-[var(--surface-secondary)] font-mono text-xs" value={scriptContent} />
                  </Field>
                </div>
              ) : (
                <Field>
                  <FieldLabel>Custom k6 Script (JavaScript)</FieldLabel>
                  <Textarea
                    rows={16}
                    className="font-mono text-xs"
                    value={scriptContent}
                    onChange={(e) => setScriptContent(e.target.value)}
                  />
                </Field>
              )}

              <div className="flex justify-end">
                <Button type="submit" disabled={saving}>
                  {saving ? <IconLoader2 size={16} className="animate-spin" /> : null}
                  Save Changes
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      )}

      <ConfirmModal
        open={deleteStepIdx !== null}
        title="Remove API Step"
        message={`Are you sure you want to remove "${deleteStepIdx !== null ? flowSteps[deleteStepIdx]?.name ?? "this step" : ""}" from the business flow?`}
        confirmLabel="Remove"
        onConfirm={() => {
          if (deleteStepIdx !== null) {
            setFlowSteps((prev) => prev.filter((_, i) => i !== deleteStepIdx));
          }
          setDeleteStepIdx(null);
        }}
        onCancel={() => setDeleteStepIdx(null)}
      />
    </ListWorkspaceLayout>
  );
}
