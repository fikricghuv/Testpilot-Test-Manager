"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useParams } from "@/lib/routeParams";
import {
  IconActivity,
  IconLoader2,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRadar2,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import {
  createPerformanceTest,
  deletePerformanceTest,
  getPerformanceRecorder,
  getPerformanceRecorderFrameUrl,
  importPerformanceHar,
  listPerformanceTests,
  performPerformanceRecorderAction,
  startPerformanceRecorder,
  stopPerformanceRecorder,
  triggerPerformanceRun,
  type PerformanceFlowStep,
  type PerformanceHttpMethod,
  type PerformanceRunStatus,
  type PerformanceTestMode,
  type PerformanceTestRecord,
  type RecordedApiCall,
  type RecorderSessionState,
} from "@/lib/api";
import {
  Button,
  Card,
  ConfirmModal,
  EmptyStateBlock,
  Field,
  FieldLabel,
  Input,
  Modal,
  PageLoader,
  Select,
  StatusChip,
  Textarea,
} from "@/components/ui";
import { Breadcrumbs, ListWorkspaceLayout, PageHeader } from "@/components/workflows";
import { useProjectData } from "@/components/project/ProjectDataProvider";

const DEFAULT_K6_SCRIPT = `import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 10,
  duration: "30s",
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<=0.01"],
  },
};

export default function () {
  const res = http.get("https://test.k6.io");
  check(res, {
    "status is 200": (r) => r.status === 200,
  });
  sleep(1);
}
`;

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

function callsToFlowSteps(calls: RecordedApiCall[]): PerformanceFlowStep[] {
  return calls.map((c, idx) => {
    let pathname = c.url;
    try {
      pathname = new URL(c.url).pathname;
    } catch {
      // keep raw url
    }
    return {
      id: c.id || `step-${idx + 1}`,
      name: `${c.method} ${pathname}`,
      method: c.method,
      url: c.url,
      headers: c.headers,
      body: c.body,
      expectedStatus: c.status && c.status >= 200 && c.status < 400 ? c.status : 200,
      sleepAfterSec: 0.5,
      enabled: true,
    };
  });
}

export default function PerformanceTestsPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const router = useRouter();
  const { project } = useProjectData();

  const [tests, setTests] = useState<PerformanceTestRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningIds, setRunningIds] = useState<Record<string, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<PerformanceTestRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Create single/script modal
  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<PerformanceTestMode>("builder");
  const [targetUrl, setTargetUrl] = useState("https://test.k6.io");
  const [method, setMethod] = useState<PerformanceHttpMethod>("GET");
  const [vus, setVus] = useState("10");
  const [durationSec, setDurationSec] = useState("15");
  const [p95ThresholdMs, setP95ThresholdMs] = useState("500");
  const [errorRateThresholdPct, setErrorRateThresholdPct] = useState("1");
  const [scriptContent, setScriptContent] = useState(DEFAULT_K6_SCRIPT);

  // Web Flow Recorder modal
  const [recorderOpen, setRecorderOpen] = useState(false);
  const [recName, setRecName] = useState("");
  const [recStartUrl, setRecStartUrl] = useState("https://test.k6.io");
  const [recSession, setRecSession] = useState<RecorderSessionState | null>(null);
  const [recFrameTick, setRecFrameTick] = useState(0);
  const [recTypeText, setRecTypeText] = useState("");
  const [recCaptured, setRecCaptured] = useState<RecordedApiCall[]>([]);
  const [recSelectedIds, setRecSelectedIds] = useState<Record<string, boolean>>({});
  const [recStarting, setRecStarting] = useState(false);
  const [recSaving, setRecSaving] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);

  const loadTests = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await listPerformanceTests(projectId);
      setTests(res.list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load performance tests.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadTests();
  }, [loadTests]);

  useEffect(() => {
    const hasActive = tests.some(
      (t) => t.latestRun && (t.latestRun.status === "queued" || t.latestRun.status === "running")
    );
    if (!hasActive) return;
    const timer = setInterval(() => {
      void loadTests();
    }, 2500);
    return () => clearInterval(timer);
  }, [tests, loadTests]);

  // Live-poll Playwright recorder session while recording
  useEffect(() => {
    if (!projectId || !recSession || recSession.status !== "recording") return;
    const timer = setInterval(() => {
      if (recSession.interactive) {
        setRecFrameTick((t) => t + 1);
      }
      void getPerformanceRecorder(projectId, recSession.sessionId)
        .then((res) => {
          setRecSession(res.session);
          setRecCaptured(res.session.capturedCalls);
          setRecSelectedIds((prev) => {
            const next = { ...prev };
            for (const c of res.session.capturedCalls) {
              if (next[c.id] === undefined) next[c.id] = true;
            }
            return next;
          });
        })
        .catch(() => undefined);
    }, 900);
    return () => clearInterval(timer);
  }, [projectId, recSession]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId) return;
    setFormError(null);
    setSaving(true);

    try {
      const res = await createPerformanceTest(projectId, {
        name: name.trim(),
        description: description.trim() || null,
        mode,
        builderConfig:
          mode === "builder"
            ? {
                targetUrl: targetUrl.trim(),
                method,
                vus: Number(vus) || 10,
                durationSec: Number(durationSec) || 15,
                p95ThresholdMs: p95ThresholdMs ? Number(p95ThresholdMs) : null,
                errorRateThresholdPct: errorRateThresholdPct ? Number(errorRateThresholdPct) : null,
                expectedStatus: 200,
                sleepSec: 1,
              }
            : null,
        scriptContent: mode === "script" ? scriptContent : null,
      });
      setCreateOpen(false);
      setName("");
      setDescription("");
      router.push(`/projects/${projectId}/performance/${res.test.id}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create performance test.");
    } finally {
      setSaving(false);
    }
  };

  const handleStartRecorder = async () => {
    if (!projectId) return;
    setRecError(null);
    setRecStarting(true);
    try {
      const res = await startPerformanceRecorder(projectId, recStartUrl.trim());
      setRecSession(res.session);
      setRecCaptured(res.session.capturedCalls);
    } catch (err) {
      setRecError(err instanceof Error ? err.message : "Failed to launch browser recorder.");
    } finally {
      setRecStarting(false);
    }
  };

  const handleStopRecorder = async () => {
    if (!projectId || !recSession) return;
    try {
      const res = await stopPerformanceRecorder(projectId, recSession.sessionId);
      setRecSession(res.session);
      setRecCaptured(res.session.capturedCalls);
    } catch (err) {
      setRecError(err instanceof Error ? err.message : "Failed to stop recorder.");
    }
  };

  const handleHarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!projectId || !e.target.files?.[0]) return;
    setRecError(null);
    try {
      const text = await e.target.files[0].text();
      const harJson = JSON.parse(text) as unknown;
      const res = await importPerformanceHar(projectId, harJson);
      setRecCaptured(res.calls);
      const selected: Record<string, boolean> = {};
      for (const c of res.calls) selected[c.id] = true;
      setRecSelectedIds(selected);
    } catch (err) {
      setRecError(err instanceof Error ? err.message : "Failed to parse HAR file.");
    }
  };

  const handleProcessRecordedToK6 = async () => {
    if (!projectId) return;
    if (recSession && recSession.status === "recording") {
      await handleStopRecorder();
    }
    const chosen = recCaptured.filter((c) => recSelectedIds[c.id] !== false);
    if (chosen.length === 0) {
      setRecError("Select at least one captured API call to generate a k6 flow.");
      return;
    }

    setRecSaving(true);
    setRecError(null);
    try {
      const flowName = recName.trim() || `Web Flow ${new Date().toLocaleTimeString()}`;
      const res = await createPerformanceTest(projectId, {
        name: flowName,
        description: `Recorded ${chosen.length} API calls from ${recStartUrl}`,
        mode: "flow",
        flowConfig: {
          vus: 10,
          durationSec: 30,
          p95ThresholdMs: 500,
          errorRateThresholdPct: 1,
          steps: callsToFlowSteps(chosen),
        },
      });
      setRecorderOpen(false);
      setRecSession(null);
      setRecCaptured([]);
      setRecName("");
      router.push(`/projects/${projectId}/performance/${res.test.id}`);
    } catch (err) {
      setRecError(err instanceof Error ? err.message : "Failed to save k6 flow.");
    } finally {
      setRecSaving(false);
    }
  };

  const handleTriggerRun = async (testId: string) => {
    if (!projectId) return;
    setRunningIds((prev) => ({ ...prev, [testId]: true }));
    try {
      await triggerPerformanceRun(projectId, testId);
      await loadTests();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to trigger performance run.");
    } finally {
      setRunningIds((prev) => ({ ...prev, [testId]: false }));
    }
  };

  const handleConfirmDelete = async () => {
    if (!projectId || !deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deletePerformanceTest(projectId, deleteTarget.id);
      setTests((prev) => prev.filter((t) => t.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete performance test.");
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return <PageLoader label="Loading performance tests..." />;
  }

  return (
    <ListWorkspaceLayout
      header={
        <PageHeader
          breadcrumb={
            <Breadcrumbs
              items={[
                { label: typeof project?.name === "string" ? project.name : "Project", href: `/projects/${projectId}` },
                { label: "Performance" },
              ]}
            />
          }
          title="Performance Tests"
          subtitle="Load, stress, and business-flow verification powered by Grafana k6."
          actions={
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setRecError(null);
                  setRecorderOpen(true);
                }}
                data-testid="record-web-flow-btn"
              >
                <IconRadar2 size={16} />
                Record Web Flow
              </Button>
              <Button onClick={() => setCreateOpen(true)} data-testid="new-performance-test-btn">
                <IconPlus size={16} />
                New Performance Test
              </Button>
            </div>
          }
        />
      }
    >
      {error ? (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {tests.length === 0 ? (
        <Card className="p-8">
          <EmptyStateBlock
            icon={<IconActivity size={28} />}
            title="No performance tests yet"
            description="Record a multi-step web business flow or create a single-API Grafana k6 scenario."
            action={
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={() => setRecorderOpen(true)}>
                  <IconRadar2 size={16} />
                  Record Web Flow
                </Button>
                <Button onClick={() => setCreateOpen(true)}>
                  <IconPlus size={16} />
                  Create Scenario
                </Button>
              </div>
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--border)] bg-[var(--surface-secondary)] text-xs uppercase text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-3 font-medium">Scenario</th>
                  <th className="px-4 py-3 font-medium">Mode / Target</th>
                  <th className="px-4 py-3 font-medium">Load</th>
                  <th className="px-4 py-3 font-medium">Last Status</th>
                  <th className="px-4 py-3 font-medium">p95 Latency</th>
                  <th className="px-4 py-3 font-medium">RPS</th>
                  <th className="px-4 py-3 font-medium">Error Rate</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {tests.map((test) => {
                  const run = test.latestRun;
                  const isActive = run?.status === "queued" || run?.status === "running" || runningIds[test.id];
                  return (
                    <tr key={test.id} className="hover:bg-[var(--surface-secondary)]/50">
                      <td className="px-4 py-3">
                        <Link
                          href={`/projects/${projectId}/performance/${test.id}`}
                          className="font-medium text-[var(--foreground)] hover:underline"
                        >
                          {test.name}
                        </Link>
                        {test.description ? (
                          <p className="mt-0.5 line-clamp-1 text-xs text-[var(--muted)]">{test.description}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-xs text-[var(--muted)]">
                        <span className="inline-block rounded bg-[var(--surface-secondary)] px-1.5 py-0.5 font-mono uppercase">
                          {test.mode}
                        </span>
                        {test.builderConfig?.targetUrl ? (
                          <span className="ml-2 font-mono">{test.builderConfig.targetUrl}</span>
                        ) : test.flowConfig ? (
                          <span className="ml-2">{test.flowConfig.steps.length} API steps</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-xs text-[var(--foreground)]">
                        {test.builderConfig
                          ? `${test.builderConfig.vus} VUs · ${test.builderConfig.durationSec}s`
                          : test.flowConfig
                          ? `${test.flowConfig.vus} VUs · ${test.flowConfig.durationSec}s`
                          : "Custom script"}
                      </td>
                      <td className="px-4 py-3">
                        {run ? (
                          <StatusChip tone={statusTone(run.status)}>
                            {run.status}
                          </StatusChip>
                        ) : (
                          <span className="text-xs text-[var(--muted)]">Never run</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {run?.p95Ms !== null && run?.p95Ms !== undefined ? `${run.p95Ms.toFixed(1)} ms` : "—"}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {run?.rps !== null && run?.rps !== undefined ? `${run.rps.toFixed(1)}/s` : "—"}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {run?.errorRate !== null && run?.errorRate !== undefined
                          ? `${(run.errorRate * 100).toFixed(2)}%`
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={Boolean(isActive)}
                            onClick={() => void handleTriggerRun(test.id)}
                          >
                            {isActive ? <IconLoader2 size={14} className="animate-spin" /> : <IconPlayerPlay size={14} />}
                            Run
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label="Delete performance test"
                            onClick={() => {
                              setDeleteError(null);
                              setDeleteTarget(test);
                            }}
                          >
                            <IconTrash size={14} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Web Flow Recorder Modal (Playwright Browser + HAR fallback) */}
      <Modal
        open={recorderOpen}
        onClose={() => {
          if (recSession?.status === "recording") {
            void handleStopRecorder();
          }
          setRecorderOpen(false);
        }}
        title="Record Web Business Flow → k6"
        className="max-w-7xl w-[95vw]"
      >
        <div className="space-y-4">
          {recError || recSession?.errorMessage ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
              {recError || recSession?.errorMessage}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Scenario Name</FieldLabel>
              <Input
                placeholder="e.g. Login & Checkout Flow"
                value={recName}
                onChange={(e) => setRecName(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>Target Web App URL</FieldLabel>
              <Input
                type="url"
                placeholder="https://app.example.com"
                value={recStartUrl}
                onChange={(e) => setRecStartUrl(e.target.value)}
                disabled={recSession?.status === "recording"}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)]/50 p-3">
            <div className="flex items-center gap-2">
              {recSession?.status !== "recording" ? (
                <Button
                  type="button"
                  disabled={recStarting}
                  onClick={() => void handleStartRecorder()}
                >
                  {recStarting ? <IconLoader2 size={16} className="animate-spin" /> : <IconRadar2 size={16} />}
                  Open Browser & Record
                </Button>
              ) : (
                <Button type="button" variant="secondary" onClick={() => void handleStopRecorder()}>
                  <IconPlayerStop size={16} />
                  Stop Recording ({recCaptured.length} APIs)
                </Button>
              )}
              {recSession?.status === "recording" ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                  Recording browser network...
                </span>
              ) : null}
            </div>

            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--surface-secondary)]">
              <IconUpload size={14} />
              Import .har
              <input type="file" accept=".har,application/json" className="hidden" onChange={handleHarUpload} />
            </label>
          </div>

          <div className={recSession?.status === "recording" && recSession.interactive ? "grid grid-cols-1 gap-4 lg:grid-cols-12" : "space-y-4"}>
            {recSession?.status === "recording" && recSession.interactive ? (
              <div className="space-y-2.5 rounded-lg border border-[var(--border)] p-3 lg:col-span-8">
                <div className="flex items-center justify-between gap-2 text-xs text-[var(--muted)]">
                  <span className="truncate font-mono">{recSession.currentUrl ?? recSession.startUrl}</span>
                  <span className="shrink-0 text-[11px] text-[var(--muted-soft)]">
                    Click, scroll, or type below
                  </span>
                </div>

                {recSession.activeSelect ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs dark:border-amber-700/60 dark:bg-amber-950/40">
                    <span className="font-medium text-amber-900 dark:text-amber-200">
                      Select dropdown option:
                    </span>
                    <Select
                      className="h-8 max-w-xs text-xs"
                      defaultValue={recSession.activeSelect.options.find((o) => o.selected)?.value ?? ""}
                      onChange={(e) => {
                        const active = recSession.activeSelect;
                        if (!active) return;
                        void performPerformanceRecorderAction(projectId, recSession.sessionId, {
                          type: "select",
                          x: active.x,
                          y: active.y,
                          value: e.target.value,
                        }).then((res) => {
                          setRecSession(res.session);
                          setRecFrameTick((t) => t + 1);
                        });
                      }}
                    >
                      {recSession.activeSelect.options.map((opt, idx) => (
                        <option key={`${opt.value}-${idx}`} value={opt.value}>
                          {opt.text}
                        </option>
                      ))}
                    </Select>
                  </div>
                ) : null}

                <div
                  className="overflow-hidden rounded border border-[var(--border)] bg-black"
                  onWheel={(e) => {
                    e.preventDefault();
                    void performPerformanceRecorderAction(projectId, recSession.sessionId, {
                      type: "scroll",
                      deltaY: Math.round(e.deltaY),
                    }).then(() => setRecFrameTick((t) => t + 1));
                  }}
                >
                  <img
                    src={getPerformanceRecorderFrameUrl(projectId, recSession.sessionId, recFrameTick)}
                    alt="Interactive browser recorder viewport"
                    className="w-full cursor-crosshair select-none"
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const x = Math.round(((e.clientX - rect.left) / rect.width) * 1280);
                      const y = Math.round(((e.clientY - rect.top) / rect.height) * 800);
                      void performPerformanceRecorderAction(projectId, recSession.sessionId, {
                        type: "click",
                        x,
                        y,
                      }).then((res) => {
                        setRecSession(res.session);
                        setRecFrameTick((t) => t + 1);
                      });
                    }}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="min-w-[200px] flex-1"
                    placeholder="Type into focused input..."
                    value={recTypeText}
                    onChange={(e) => setRecTypeText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && recTypeText) {
                        e.preventDefault();
                        void performPerformanceRecorderAction(projectId, recSession.sessionId, {
                          type: "type",
                          text: recTypeText,
                        }).then(() => {
                          setRecTypeText("");
                          setRecFrameTick((t) => t + 1);
                        });
                      }
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      if (!recTypeText) return;
                      void performPerformanceRecorderAction(projectId, recSession.sessionId, {
                        type: "type",
                        text: recTypeText,
                      }).then(() => {
                        setRecTypeText("");
                        setRecFrameTick((t) => t + 1);
                      });
                    }}
                  >
                    Send Text
                  </Button>
                  {(["ArrowUp", "ArrowDown", "Enter", "Escape"] as const).map((k) => (
                    <Button
                      key={k}
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        void performPerformanceRecorderAction(projectId, recSession.sessionId, {
                          type: "key",
                          key: k,
                        }).then(() => setRecFrameTick((t) => t + 1));
                      }}
                    >
                      {k === "ArrowUp" ? "↑" : k === "ArrowDown" ? "↓" : k}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            <div
              className={`overflow-y-auto rounded-lg border border-[var(--border)] ${
                recSession?.status === "recording" && recSession.interactive
                  ? "max-h-[560px] lg:col-span-4"
                  : "max-h-64"
              }`}
            >
              {recCaptured.length === 0 ? (
                <div className="p-6 text-center text-xs text-[var(--muted)]">
                  Click &ldquo;Open Browser & Record&rdquo; to launch a browser window and capture all XHR/Fetch API calls, or import a <code>.har</code> file.
                </div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-[var(--border)] bg-[var(--surface-secondary)] text-[var(--muted)]">
                    <tr>
                      <th className="w-8 px-3 py-2">Use</th>
                      <th className="px-3 py-2">Method</th>
                      <th className="px-3 py-2">URL</th>
                      <th className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {recCaptured.map((call) => (
                      <tr key={call.id}>
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={recSelectedIds[call.id] !== false}
                            onChange={(e) =>
                              setRecSelectedIds((prev) => ({ ...prev, [call.id]: e.target.checked }))
                            }
                          />
                        </td>
                        <td className="px-3 py-2 font-mono font-semibold">{call.method}</td>
                        <td className="max-w-[200px] truncate px-3 py-2 font-mono" title={call.url}>
                          {call.url}
                        </td>
                        <td className="px-3 py-2 font-mono">{call.status ?? "…"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setRecorderOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={recSaving || recCaptured.length === 0}
              onClick={() => void handleProcessRecordedToK6()}
            >
              {recSaving ? <IconLoader2 size={16} className="animate-spin" /> : null}
              Process to k6 Script ({recCaptured.filter((c) => recSelectedIds[c.id] !== false).length})
            </Button>
          </div>
        </div>
      </Modal>

      {/* Single API / Custom Script Modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New Performance Test (k6)"
        className="max-w-2xl"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          {formError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
              {formError}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Scenario Name</FieldLabel>
              <Input
                required
                placeholder="e.g. Checkout API Smoke Load"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>Authoring Mode</FieldLabel>
              <Select value={mode} onChange={(e) => setMode(e.target.value as PerformanceTestMode)}>
                <option value="builder">Single API Builder</option>
                <option value="script">Custom k6 JavaScript</option>
              </Select>
            </Field>
          </div>

          <Field>
            <FieldLabel>Description (optional)</FieldLabel>
            <Input
              placeholder="What endpoint or SLA does this test verify?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
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
                  <Input
                    required
                    type="url"
                    placeholder="https://api.example.com/health"
                    value={targetUrl}
                    onChange={(e) => setTargetUrl(e.target.value)}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Field>
                  <FieldLabel>Virtual Users (1-100)</FieldLabel>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={vus}
                    onChange={(e) => setVus(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel>Duration (sec, 1-300)</FieldLabel>
                  <Input
                    type="number"
                    min={1}
                    max={300}
                    value={durationSec}
                    onChange={(e) => setDurationSec(e.target.value)}
                  />
                </Field>
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
            </div>
          ) : (
            <Field>
              <FieldLabel>k6 Script (JavaScript)</FieldLabel>
              <Textarea
                rows={12}
                className="font-mono text-xs"
                value={scriptContent}
                onChange={(e) => setScriptContent(e.target.value)}
              />
            </Field>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <IconLoader2 size={16} className="animate-spin" /> : null}
              Create Scenario
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title="Delete Performance Test"
        message={`Are you sure you want to delete "${deleteTarget?.name ?? ""}"? Run history for this scenario will no longer be accessible.`}
        confirmLabel="Delete"
        loadingLabel="Deleting..."
        loading={deleting}
        error={deleteError}
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => {
          if (!deleting) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      />
    </ListWorkspaceLayout>
  );
}
