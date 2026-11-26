"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  IconAlertCircle,
  IconCheck,
  IconChevronRight,
  IconCode,
  IconLoader2,
  IconNetwork,
  IconTerminal2,
  IconTimeline,
  IconX,
} from "@tabler/icons-react";
import { getExecutionTraceSummary, type ExecutionTraceSummary } from "@/lib/api";

type RightTab = "call" | "errors" | "network" | "console";
type SnapshotPhase = "after" | "before";

export default function TraceInspectorPage() {
  const params = useParams<{ cycleId: string; executionId: string; attachmentId: string }>();
  const cycleId = params?.cycleId ?? "";
  const executionId = params?.executionId ?? "";
  const attachmentId = params?.attachmentId ?? "";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ExecutionTraceSummary | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [filmstripOverrideUrl, setFilmstripOverrideUrl] = useState<string | null>(null);
  const [snapshotPhase, setSnapshotPhase] = useState<SnapshotPhase>("after");
  const [rightTab, setRightTab] = useState<RightTab>("call");

  useEffect(() => {
    if (!cycleId || !executionId || !attachmentId) return;
    let cancelled = false;
    setLoading(true);
    getExecutionTraceSummary(cycleId, executionId, attachmentId)
      .then((data) => {
        if (cancelled) return;
        setSummary(data);
        const firstFailed = data.steps.findIndex((s) => s.status === "failed");
        setSelectedIdx(firstFailed >= 0 ? firstFailed : 0);
        if (data.errors.length > 0) setRightTab("errors");
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load execution trace.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cycleId, executionId, attachmentId]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!summary?.steps.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFilmstripOverrideUrl(null);
        setSelectedIdx((i) => Math.min(summary.steps.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFilmstripOverrideUrl(null);
        setSelectedIdx((i) => Math.max(0, i - 1));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [summary]);

  const selectedStep = summary?.steps[selectedIdx] ?? null;

  const activeImageUrl = useMemo(() => {
    if (filmstripOverrideUrl) return filmstripOverrideUrl;
    if (!selectedStep) return null;
    return snapshotPhase === "before"
      ? selectedStep.beforeFrameDataUrl || selectedStep.frameDataUrl
      : selectedStep.frameDataUrl || selectedStep.beforeFrameDataUrl;
  }, [filmstripOverrideUrl, selectedStep, snapshotPhase]);

  const pointOverlay = useMemo(() => {
    if (filmstripOverrideUrl || !selectedStep?.point || !summary?.metadata.viewport) return null;
    const { width, height } = summary.metadata.viewport;
    if (!width || !height) return null;
    return {
      leftPct: Math.max(0, Math.min(100, (selectedStep.point.x / width) * 100)),
      topPct: Math.max(0, Math.min(100, (selectedStep.point.y / height) * 100)),
    };
  }, [filmstripOverrideUrl, selectedStep, summary]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--background)] text-sm text-[var(--muted)]">
        <IconLoader2 size={18} className="mr-2 animate-spin" />
        Loading TestPilot Trace Inspector...
      </div>
    );
  }

  if (error || !summary) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--background)] p-6">
        <div className="max-w-md rounded-xl border border-[var(--error)]/40 bg-[var(--surface)] p-5 text-sm text-[var(--error-foreground)]">
          {error || "Trace data is unavailable."}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      {/* Top Header */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--brand-primary)]/15 text-[var(--brand-primary)]">
            <IconTimeline size={17} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold">TestPilot Trace Inspector</h1>
              <span className="rounded bg-[var(--surface-secondary)] px-2 py-0.5 font-mono text-[11px] text-[var(--muted)]">
                {summary.fileName}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--muted)]">
              {summary.metadata.browserName && <span>Browser: {summary.metadata.browserName}</span>}
              {summary.metadata.viewport && (
                <span>
                  Viewport: {summary.metadata.viewport.width}×{summary.metadata.viewport.height}
                </span>
              )}
              {summary.metadata.totalDurationMs != null && (
                <span>Duration: {summary.metadata.totalDurationMs} ms</span>
              )}
              <span>Use ↑ / ↓ keys to step through actions</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-2.5 py-1">
            {summary.steps.length} actions
          </span>
          {summary.errors.length > 0 && (
            <span className="rounded-md border border-[var(--error)]/40 bg-[var(--error)]/10 px-2.5 py-1 font-medium text-[var(--error)]">
              {summary.errors.length} error
            </span>
          )}
        </div>
      </header>

      {/* Filmstrip Timeline */}
      {summary.filmstrip.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-4 py-2">
          <span className="shrink-0 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--muted)]">
            Timeline
          </span>
          {summary.filmstrip.map((frame, i) => {
            const isSelected = filmstripOverrideUrl === frame.frameDataUrl;
            return (
              <button
                key={i}
                type="button"
                onClick={() => setFilmstripOverrideUrl(frame.frameDataUrl)}
                className={`group shrink-0 overflow-hidden rounded border transition ${
                  isSelected
                    ? "border-[var(--brand-primary)] ring-2 ring-[var(--brand-primary)]/30"
                    : "border-[var(--border-subtle)] hover:border-[var(--brand-primary)]/60"
                }`}
                title={`${frame.offsetMs} ms`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={frame.frameDataUrl} alt={`Frame ${frame.offsetMs}ms`} className="h-11 w-20 object-cover" />
                <div className="bg-[var(--surface)] px-1 py-0.5 text-center font-mono text-[9.5px] text-[var(--muted)]">
                  {frame.offsetMs}ms
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Main 3-Pane IDE Body */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-12">
        {/* Left: Actions */}
        <aside className="flex min-h-0 flex-col border-b border-[var(--border-subtle)] lg:col-span-3 lg:border-b-0 lg:border-r">
          <div className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
            Actions ({summary.steps.length})
          </div>
          <div className="min-h-0 flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto">
            {summary.steps.length === 0 ? (
              <div className="p-4 text-xs text-[var(--muted)]">No user actions recorded in this trace.</div>
            ) : (
              summary.steps.map((step, i) => {
                const active = i === selectedIdx && !filmstripOverrideUrl;
                return (
                  <button
                    key={step.callId || i}
                    type="button"
                    onClick={() => {
                      setFilmstripOverrideUrl(null);
                      setSelectedIdx(i);
                    }}
                    className={`flex w-full items-start justify-between gap-2 px-3.5 py-2.5 text-left transition-colors ${
                      active ? "bg-[var(--brand-primary)]/12" : "hover:bg-[var(--surface-secondary)]"
                    }`}
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      <span
                        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
                          step.status === "failed"
                            ? "bg-[var(--error)]/15 text-[var(--error)]"
                            : "bg-[var(--success)]/15 text-[var(--success)]"
                        }`}
                      >
                        {step.status === "failed" ? <IconX size={10} /> : <IconCheck size={10} />}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs font-medium text-[var(--foreground)]">
                            {step.apiName}
                          </span>
                          {step.line != null && (
                            <span className="rounded bg-[var(--surface)] px-1 font-mono text-[10px] text-[var(--muted)]">
                              L{step.line}
                            </span>
                          )}
                        </div>
                        {step.selector && (
                          <p className="truncate font-mono text-[11px] text-[var(--muted)]" title={step.selector}>
                            {step.selector}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--muted)]">
                      {step.durationMs != null && <span className="font-mono">{step.durationMs}ms</span>}
                      {active && <IconChevronRight size={13} className="text-[var(--brand-primary)]" />}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Center: Snapshot Preview */}
        <main className="flex min-h-0 flex-col border-b border-[var(--border-subtle)] lg:col-span-5 lg:border-b-0 lg:border-r">
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-3.5 py-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              {filmstripOverrideUrl ? "Timeline Frame" : `Snapshot (${snapshotPhase})`}
            </span>
            {!filmstripOverrideUrl && (
              <div className="flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-0.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => setSnapshotPhase("before")}
                  className={`rounded px-2 py-0.5 font-medium transition ${
                    snapshotPhase === "before"
                      ? "bg-[var(--brand-primary)] text-white"
                      : "text-[var(--muted)] hover:text-[var(--foreground)]"
                  }`}
                >
                  Before
                </button>
                <button
                  type="button"
                  onClick={() => setSnapshotPhase("after")}
                  className={`rounded px-2 py-0.5 font-medium transition ${
                    snapshotPhase === "after"
                      ? "bg-[var(--brand-primary)] text-white"
                      : "text-[var(--muted)] hover:text-[var(--foreground)]"
                  }`}
                >
                  After
                </button>
              </div>
            )}
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
            {selectedStep?.error && !filmstripOverrideUrl && (
              <div className="shrink-0 rounded-lg border border-[var(--error)]/50 bg-[var(--error)]/10 p-3 font-mono text-xs text-[var(--error-foreground)] whitespace-pre-wrap">
                {selectedStep.error}
              </div>
            )}

            {activeImageUrl ? (
              <div className="relative mx-auto overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] shadow-sm">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={activeImageUrl}
                  alt={selectedStep ? `Snapshot for ${selectedStep.apiName}` : "Trace frame"}
                  className="max-h-[70vh] w-auto object-contain"
                />
                {pointOverlay && (
                  <span
                    className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[var(--error)] shadow"
                    style={{ left: `${pointOverlay.leftPct}%`, top: `${pointOverlay.topPct}%` }}
                    title={`Action point (${selectedStep?.point?.x}, ${selectedStep?.point?.y})`}
                  />
                )}
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-[var(--border-subtle)] text-xs text-[var(--muted)]">
                No visual frame captured for this step.
              </div>
            )}
          </div>
        </main>

        {/* Right: Call / Errors / Network / Console */}
        <aside className="flex min-h-0 flex-col lg:col-span-4">
          <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-3.5 text-xs">
            {(
              [
                { key: "call", label: "Call", icon: IconCode },
                { key: "errors", label: `Errors (${summary.errors.length})`, icon: IconAlertCircle },
                { key: "network", label: `Network (${summary.network.length})`, icon: IconNetwork },
                { key: "console", label: `Console (${summary.console.length})`, icon: IconTerminal2 },
              ] as const
            ).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setRightTab(key)}
                className={`inline-flex items-center gap-1.5 border-b-2 py-2.5 font-medium transition-colors ${
                  rightTab === key
                    ? "border-[var(--brand-primary)] text-[var(--foreground)]"
                    : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                <Icon size={13} />
                {label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3.5 text-xs">
            {rightTab === "call" && (
              selectedStep ? (
                <div className="space-y-3">
                  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-3 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-semibold">{selectedStep.apiName}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${
                          selectedStep.status === "failed"
                            ? "bg-[var(--error)]/15 text-[var(--error)]"
                            : "bg-[var(--success)]/15 text-[var(--success)]"
                        }`}
                      >
                        {selectedStep.status}
                      </span>
                    </div>
                    {selectedStep.durationMs != null && (
                      <div className="text-[var(--muted)]">Duration: {selectedStep.durationMs} ms</div>
                    )}
                    {selectedStep.line != null && (
                      <div className="text-[var(--muted)]">Source line: L{selectedStep.line}</div>
                    )}
                    {selectedStep.point && (
                      <div className="text-[var(--muted)]">
                        Target point: ({selectedStep.point.x}, {selectedStep.point.y})
                      </div>
                    )}
                  </div>

                  {selectedStep.selector && (
                    <div className="space-y-1">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">Locator</div>
                      <pre className="overflow-x-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-2.5 font-mono text-[11px]">
                        {selectedStep.selector}
                      </pre>
                    </div>
                  )}

                  {selectedStep.params && (
                    <div className="space-y-1">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">Parameters</div>
                      <pre className="overflow-x-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-2.5 font-mono text-[11px]">
                        {JSON.stringify(selectedStep.params, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-[var(--muted)]">Select an action to inspect its call details.</p>
              )
            )}

            {rightTab === "errors" && (
              summary.errors.length === 0 ? (
                <p className="text-[var(--muted)]">No errors recorded.</p>
              ) : (
                <div className="space-y-2.5">
                  {summary.errors.map((err, i) => (
                    <div
                      key={i}
                      className="rounded-lg border border-[var(--error)]/40 bg-[var(--error)]/10 p-3 font-mono text-[11px] text-[var(--error-foreground)] whitespace-pre-wrap"
                    >
                      {err.message}
                      {err.stack ? `\n\n${err.stack}` : ""}
                    </div>
                  ))}
                </div>
              )
            )}

            {rightTab === "network" && (
              summary.network.length === 0 ? (
                <p className="text-[var(--muted)]">No network requests recorded.</p>
              ) : (
                <div className="space-y-1">
                  {summary.network.map((req, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--surface-secondary)]"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="rounded bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[10px] font-semibold">
                          {req.method}
                        </span>
                        <span
                          className={`font-mono text-[11px] ${
                            req.status && req.status >= 400 ? "text-[var(--error)]" : "text-[var(--success)]"
                          }`}
                        >
                          {req.status ?? "—"}
                        </span>
                        <span className="truncate font-mono text-[11px]" title={req.url}>
                          {req.url}
                        </span>
                      </div>
                      {req.durationMs != null && (
                        <span className="shrink-0 font-mono text-[10.5px] text-[var(--muted)]">{req.durationMs}ms</span>
                      )}
                    </div>
                  ))}
                </div>
              )
            )}

            {rightTab === "console" && (
              summary.console.length === 0 ? (
                <p className="text-[var(--muted)]">No console output recorded.</p>
              ) : (
                <div className="space-y-1 font-mono text-[11px]">
                  {summary.console.map((entry, i) => (
                    <div key={i} className="flex items-start gap-2 rounded px-2 py-1 hover:bg-[var(--surface-secondary)]">
                      <span className="shrink-0 uppercase text-[10px] text-[var(--muted)]">[{entry.level}]</span>
                      <span className="break-all">{entry.text}</span>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
