"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconBug,
  IconCode,
  IconDeviceFloppy,
  IconDownload,
  IconHistory,
  IconLoader2,
  IconPlayerPlay,
  IconPlayerRecord,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import {
  API_BASE,
  activateTestCaseScriptVersion,
  createTestCaseRecorderSession,
  deleteTestCaseScript,
  deleteTestCaseScriptVersion,
  getTestCaseScript,
  getTestCaseScriptRun,
  runTestCaseScript,
  saveTestCaseScript,
  type TestScriptRunRecord,
  type TestScriptStateResponse,
  type TestScriptStatus,
} from "@/lib/api";
import { Button, CopyButton, Field, FieldLabel, Input, StatusChip } from "@/components/ui";
import ExecutionEvidencePanel from "@/components/ExecutionEvidencePanel";
import { formatDateTime } from "@/lib/date";

interface TestCaseScriptTabProps {
  projectId: string;
  testcaseId: string;
  testcaseTitle: string;
  testcaseExternalId?: string | null;
}

function buildStarterTemplate(title: string, externalId?: string | null, targetUrl?: string): string {
  const label = externalId ? `[${externalId}] ${title}` : title || "Automated test";
  const url = targetUrl?.trim() || "https://example.com";
  return [
    `import { test, expect } from "@playwright/test";`,
    ``,
    `test(${JSON.stringify(label)}, async ({ page }) => {`,
    `  await page.goto(${JSON.stringify(url)});`,
    `  await expect(page).toHaveTitle(/.+/);`,
    `});`,
    ``,
  ].join("\n");
}

function runStatusTone(status: TestScriptRunRecord["status"]) {
  if (status === "passed") return "success" as const;
  if (status === "failed" || status === "error") return "error" as const;
  if (status === "running" || status === "queued") return "warning" as const;
  return "neutral" as const;
}

function parsePlaywrightErrorLine(errorMessage?: string | null): number | null {
  if (!errorMessage) return null;
  const match = errorMessage.match(/test\.spec\.ts:(\d+):\d+/);
  if (!match) return null;
  const line = Number(match[1]);
  return Number.isInteger(line) && line > 0 ? line : null;
}

export function TestCaseScriptTab({
  projectId,
  testcaseId,
  testcaseTitle,
  testcaseExternalId,
}: TestCaseScriptTabProps) {
  const [state, setState] = useState<TestScriptStateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [launchingRecorder, setLaunchingRecorder] = useState(false);
  const [extensionReady, setExtensionReady] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [scriptContent, setScriptContent] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [status, setStatus] = useState<TestScriptStatus>("draft");
  const [notes, setNotes] = useState("");
  const [dirty, setDirty] = useState(false);

  const [activeRun, setActiveRun] = useState<TestScriptRunRecord | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const applyLoadedState = useCallback((data: TestScriptStateResponse) => {
    setState(data);
    setScriptContent(data.script?.scriptContent ?? "");
    setTargetUrl(data.script?.targetUrl ?? "");
    setStatus(data.script?.status ?? "draft");
    setNotes("");
    setDirty(false);
    if (data.recentRuns.length > 0) {
      setActiveRun(data.recentRuns[0]);
    } else {
      setActiveRun(null);
    }
  }, []);

  const loadScript = useCallback(async () => {
    setError(null);
    try {
      const data = await getTestCaseScript(projectId, testcaseId);
      applyLoadedState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load automation script.");
    } finally {
      setLoading(false);
    }
  }, [projectId, testcaseId, applyLoadedState]);

  useEffect(() => {
    let cancelled = false;
    getTestCaseScript(projectId, testcaseId)
      .then((data) => {
        if (!cancelled) applyLoadedState(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load automation script.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [projectId, testcaseId, applyLoadedState, stopPolling]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== window || !event.data || typeof event.data !== "object") return;
      if (event.data.type === "TESTPILOT_RECORDER_PONG") {
        setExtensionReady(true);
      } else if (
        event.data.type === "TESTPILOT_RECORDER_SAVED" &&
        event.data.projectId === projectId &&
        event.data.testcaseId === testcaseId
      ) {
        void loadScript();
      }
    }
    function onFocusOrVisible() {
      if (document.visibilityState === "visible" && !dirty) {
        void loadScript();
      }
    }
    window.addEventListener("message", onMessage);
    window.addEventListener("focus", onFocusOrVisible);
    document.addEventListener("visibilitychange", onFocusOrVisible);
    window.postMessage({ type: "TESTPILOT_RECORDER_PING" }, "*");
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocusOrVisible);
      document.removeEventListener("visibilitychange", onFocusOrVisible);
    };
  }, [projectId, testcaseId, dirty, loadScript]);

  useEffect(() => {
    if (!activeRun || (activeRun.status !== "queued" && activeRun.status !== "running")) {
      stopPolling();
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await getTestCaseScriptRun(projectId, testcaseId, activeRun.id);
        if (cancelled) return;
        setActiveRun(res.run);
        if (res.run.status === "queued" || res.run.status === "running") {
          pollTimerRef.current = setTimeout(poll, 1500);
        } else {
          setRunning(false);
          const refreshed = await getTestCaseScript(projectId, testcaseId);
          if (!cancelled) setState(refreshed);
        }
      } catch {
        if (!cancelled) {
          setRunning(false);
        }
      }
    };
    pollTimerRef.current = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [activeRun, projectId, testcaseId, stopPolling]);

  async function handleSave() {
    if (!scriptContent.trim()) {
      setError("Script content cannot be empty.");
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await saveTestCaseScript(projectId, testcaseId, {
        scriptContent,
        framework: "playwright-ts",
        targetUrl: targetUrl.trim() || null,
        status,
        notes: notes.trim() || null,
      });
      applyLoadedState(updated);
      setSuccess(`Saved version v${updated.script?.activeVersion ?? 1}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save automation script.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRun() {
    setError(null);
    setSuccess(null);
    setRunning(true);
    try {
      if (dirty) {
        const updated = await saveTestCaseScript(projectId, testcaseId, {
          scriptContent,
          framework: "playwright-ts",
          targetUrl: targetUrl.trim() || null,
          status,
          notes: notes.trim() || "Auto-saved before run",
        });
        applyLoadedState(updated);
      }
      const res = await runTestCaseScript(projectId, testcaseId, {
        targetUrl: targetUrl.trim() || null,
      });
      setActiveRun(res.run);
    } catch (err) {
      setRunning(false);
      setError(err instanceof Error ? err.message : "Failed to start script run.");
    }
  }

  async function handleActivateVersion(versionId: string) {
    setError(null);
    setSuccess(null);
    try {
      const updated = await activateTestCaseScriptVersion(projectId, testcaseId, versionId);
      applyLoadedState(updated);
      setSuccess(`Activated version v${updated.script?.activeVersion ?? ""}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to restore version.");
    }
  }

  async function handleDelete() {
    const activeVersionId = state?.script?.activeVersionId;
    const deletedVersionNum = state?.script?.activeVersion;
    setDeleting(true);
    setError(null);
    setSuccess(null);
    try {
      if (activeVersionId) {
        const updated = await deleteTestCaseScriptVersion(projectId, testcaseId, activeVersionId);
        applyLoadedState(updated);
        setSuccess(
          updated.script
            ? `Deleted version v${deletedVersionNum ?? ""}. Active version is now v${updated.script.activeVersion ?? ""}.`
            : "Automation script removed."
        );
      } else {
        await deleteTestCaseScript(projectId, testcaseId);
        setState({ script: null, versions: [], recentRuns: [] });
        setScriptContent("");
        setTargetUrl("");
        setStatus("draft");
        setNotes("");
        setDirty(false);
        setActiveRun(null);
        setSuccess("Automation script removed.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete script version.");
    } finally {
      setDeleting(false);
    }
  }

  async function handleLaunchRecorder() {
    const trimmedUrl = targetUrl.trim();
    if (!trimmedUrl) {
      setError("Enter a Target URL below before launching the Web Recorder.");
      return;
    }
    try {
      const parsed = new URL(trimmedUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        setError("Target URL must use http:// or https://.");
        return;
      }
    } catch {
      setError("Target URL must be a valid URL (e.g. https://staging.example.com).");
      return;
    }

    setLaunchingRecorder(true);
    setError(null);
    setSuccess(null);
    try {
      const session = await createTestCaseRecorderSession(projectId, testcaseId);
      const ack = await new Promise<{ ok: boolean; error?: string | null }>((resolve) => {
        const timeout = setTimeout(() => {
          window.removeEventListener("message", handleAck);
          resolve({
            ok: false,
            error: "TestPilot Web Recorder extension not detected. Load sdk/chrome-recorder in chrome://extensions and reload this page.",
          });
        }, 1200);

        function handleAck(event: MessageEvent) {
          if (event.source !== window || event.data?.type !== "TESTPILOT_START_RECORDING_ACK") return;
          clearTimeout(timeout);
          window.removeEventListener("message", handleAck);
          resolve({ ok: Boolean(event.data.ok), error: event.data.error });
        }

        window.addEventListener("message", handleAck);
        window.postMessage(
          {
            type: "TESTPILOT_START_RECORDING",
            payload: {
              apiBaseUrl: API_BASE,
              token: session.token,
              projectId: session.projectId,
              testcaseId: session.testcaseId,
              testcaseTitle: session.testcaseTitle,
              testcaseExternalId: session.testcaseExternalId,
              targetUrl: trimmedUrl,
            },
          },
          "*"
        );
      });

      if (!ack.ok) {
        setError(ack.error || "Failed to launch Web Recorder.");
        return;
      }
      setExtensionReady(true);
      setSuccess("Web Recorder opened in a new tab. Click Save & Run in the floating modal when done.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start Web Recorder session.");
    } finally {
      setLaunchingRecorder(false);
    }
  }

  async function handleDebugInExtension() {
    if (!scriptContent.trim()) {
      setError("Write or record a Playwright spec before debugging.");
      return;
    }
    setLaunchingRecorder(true);
    setError(null);
    setSuccess(null);
    try {
      const ack = await new Promise<{ ok: boolean; error?: string | null }>((resolve) => {
        const timeout = setTimeout(() => {
          window.removeEventListener("message", handleAck);
          resolve({
            ok: false,
            error: "TestPilot Chrome extension not detected. Load sdk/chrome-recorder in chrome://extensions and reload this page.",
          });
        }, 1200);

        function handleAck(event: MessageEvent) {
          if (event.source !== window || event.data?.type !== "TESTPILOT_START_DEBUG_ACK") return;
          clearTimeout(timeout);
          window.removeEventListener("message", handleAck);
          resolve({ ok: Boolean(event.data.ok), error: event.data.error });
        }

        window.addEventListener("message", handleAck);
        window.postMessage(
          {
            type: "TESTPILOT_START_DEBUG",
            payload: {
              testcaseId,
              testcaseTitle,
              testcaseExternalId,
              targetUrl: targetUrl.trim() || null,
              scriptContent,
            },
          },
          "*"
        );
      });

      if (!ack.ok) {
        setError(ack.error || "Failed to launch Step-by-Step Debugger.");
        return;
      }
      setExtensionReady(true);
      setSuccess("Step-by-Step Debugger opened in a new Chrome tab.");
    } finally {
      setLaunchingRecorder(false);
    }
  }

  function jumpToLine(lineNumber: number) {
    const el = textareaRef.current;
    if (!el) return;
    const lines = scriptContent.split("\n");
    const targetIdx = Math.max(0, Math.min(lineNumber - 1, lines.length - 1));
    let start = 0;
    for (let i = 0; i < targetIdx; i += 1) {
      start += lines[i].length + 1;
    }
    const end = start + lines[targetIdx].length;
    el.focus();
    el.setSelectionRange(start, end);
  }

  function handleDownload() {
    if (!scriptContent.trim()) return;
    const slug = (testcaseExternalId || testcaseId).replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();
    const blob = new Blob([scriptContent], { type: "text/typescript;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug}.spec.ts`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
          <IconLoader2 size={16} className="animate-spin" />
          Loading automation script...
        </div>
      </div>
    );
  }

  const isRunning = running || activeRun?.status === "queued" || activeRun?.status === "running";

  return (
    <div className="space-y-5 px-6 py-5">
      {error && (
        <p className="rounded-lg border border-[var(--error)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--error-foreground)]">
          {error}
        </p>
      )}
      {success && (
        <p className="rounded-lg border border-[var(--success)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--success-foreground)]">
          {success}
        </p>
      )}

      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--background)] px-4 py-3">
        <div className="flex items-center gap-2">
          <IconCode size={18} className="text-[var(--brand-primary)]" />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-[var(--foreground)]">Playwright (TypeScript)</span>
              {state?.script?.activeVersion != null && (
                <StatusChip tone="brand">v{state.script.activeVersion}</StatusChip>
              )}
              {state?.script?.source && (
                <StatusChip tone="neutral">{state.script.source}</StatusChip>
              )}
            </div>
            <p className="text-xs text-[var(--muted)]">
              Write or paste an executable Playwright spec for this test case.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleLaunchRecorder}
            disabled={launchingRecorder}
            title={extensionReady ? "Chrome extension connected" : "Requires sdk/chrome-recorder Chrome extension"}
          >
            {launchingRecorder ? (
              <IconLoader2 size={14} className="animate-spin" />
            ) : (
              <IconPlayerRecord size={14} className={extensionReady ? "text-[var(--error)]" : undefined} />
            )}
            {launchingRecorder ? "Launching..." : "Record with Extension"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleDebugInExtension}
            disabled={launchingRecorder || !scriptContent.trim()}
            title="Step through each Playwright line in Chrome"
          >
            <IconBug size={14} />
            Debug in Extension
          </Button>
          {!scriptContent.trim() && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setScriptContent(buildStarterTemplate(testcaseTitle, testcaseExternalId, targetUrl));
                setDirty(true);
              }}
            >
              Insert Starter Template
            </Button>
          )}
          {scriptContent.trim() && (
            <>
              <CopyButton value={scriptContent} label="Copy" />
              <Button type="button" variant="secondary" size="sm" onClick={handleDownload}>
                <IconDownload size={14} />
                .spec.ts
              </Button>
            </>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleSave}
            disabled={saving || !scriptContent.trim()}
          >
            <IconDeviceFloppy size={14} />
            {saving ? "Saving..." : "Save Script"}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleRun}
            disabled={isRunning || !scriptContent.trim()}
          >
            {isRunning ? <IconLoader2 size={14} className="animate-spin" /> : <IconPlayerPlay size={14} />}
            {isRunning ? "Running..." : "Run Playwright"}
          </Button>
        </div>
      </div>

      {/* Metadata fields */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field className="sm:col-span-2">
          <FieldLabel>Target Base URL (optional)</FieldLabel>
          <Input
            type="url"
            value={targetUrl}
            onChange={(e) => {
              setTargetUrl(e.target.value);
              setDirty(true);
            }}
            placeholder="https://staging.example.com"
          />
        </Field>
        <Field>
          <FieldLabel>Script Status</FieldLabel>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as TestScriptStatus);
              setDirty(true);
            }}
            className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--foreground)] focus:border-[var(--brand-primary)] focus:outline-none"
          >
            <option value="draft">Draft</option>
            <option value="verified">Verified</option>
            <option value="archived">Archived</option>
          </select>
        </Field>
      </div>

      {/* Code editor */}
      <Field>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel>Playwright Spec Code</FieldLabel>
          {activeRun && parsePlaywrightErrorLine(activeRun.errorMessage) && (
            <button
              type="button"
              onClick={() => jumpToLine(parsePlaywrightErrorLine(activeRun.errorMessage)!)}
              className="text-xs font-medium text-[var(--error-foreground)] underline hover:opacity-80"
            >
              Jump to failing line {parsePlaywrightErrorLine(activeRun.errorMessage)}
            </button>
          )}
        </div>
        <textarea
          ref={textareaRef}
          value={scriptContent}
          onChange={(e) => {
            setScriptContent(e.target.value);
            setDirty(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Tab") {
              e.preventDefault();
              const target = e.currentTarget;
              const start = target.selectionStart;
              const end = target.selectionEnd;
              const next = scriptContent.slice(0, start) + "  " + scriptContent.slice(end);
              setScriptContent(next);
              setDirty(true);
              requestAnimationFrame(() => {
                target.selectionStart = target.selectionEnd = start + 2;
              });
            }
          }}
          rows={15}
          spellCheck={false}
          placeholder={`import { test, expect } from "@playwright/test";\n\ntest("...", async ({ page }) => {\n  ...\n});`}
          className="w-full rounded-xl border border-[var(--border)] bg-[var(--background)] p-3.5 font-mono text-xs leading-relaxed text-[var(--foreground)] focus:border-[var(--brand-primary)] focus:outline-none"
        />
      </Field>

      <Field>
        <FieldLabel>Version Note (optional)</FieldLabel>
        <Input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Updated login selector for staging"
        />
      </Field>

      {/* Latest Run Output */}
      {activeRun && (
        <div className="space-y-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--background)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
                Latest Execution
              </span>
              <StatusChip tone={runStatusTone(activeRun.status)}>{activeRun.status}</StatusChip>
              {activeRun.durationMs != null && (
                <span className="text-xs text-[var(--muted)]">{activeRun.durationMs} ms</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {activeRun.cycleId && (
                <Link
                  href={`/projects/${projectId}/cycles/${activeRun.cycleId}`}
                  className="text-xs font-medium text-[var(--accent-light)] hover:underline"
                >
                  View in Test Runs →
                </Link>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={loadScript} title="Refresh">
                <IconRefresh size={14} />
              </Button>
            </div>
          </div>

          {activeRun.errorMessage && (
            <pre className="max-h-40 overflow-auto rounded-lg border border-[var(--error)]/40 bg-[var(--surface)] p-3 font-mono text-[11px] text-[var(--error-foreground)] whitespace-pre-wrap">
              {activeRun.errorMessage}
            </pre>
          )}
          {activeRun.stdout && (
            <pre className="max-h-48 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-3 font-mono text-[11px] text-[var(--foreground)] whitespace-pre-wrap">
              {activeRun.stdout}
            </pre>
          )}
          {activeRun.cycleId &&
            activeRun.executionId &&
            activeRun.status !== "queued" &&
            activeRun.status !== "running" && (
              <ExecutionEvidencePanel
                key={`${activeRun.executionId}-${activeRun.status}`}
                cycleId={activeRun.cycleId}
                executionId={activeRun.executionId}
                readOnly
              />
            )}
        </div>
      )}

      {/* Version History & Danger Zone */}
      {state && state.versions.length > 0 && (
        <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--background)] p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
              <IconHistory size={14} />
              Version History ({state.versions.length})
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
              className="text-[var(--error-foreground)]"
            >
              <IconTrash size={14} />
              {deleting ? "Deleting..." : "Delete Script"}
            </Button>
          </div>
          <div className="divide-y divide-[var(--border-subtle)]">
            {state.versions.slice(0, 6).map((ver) => {
              const isActive = ver.id === state.script?.activeVersionId;
              return (
                <div key={ver.id} className="flex items-center justify-between gap-3 py-2 text-xs">
                  <div className="min-w-0">
                    <span className="font-semibold text-[var(--foreground)]">v{ver.version}</span>
                    <span className="ml-2 text-[var(--muted)]">({ver.source})</span>
                    {ver.notes && <span className="ml-2 text-[var(--muted-soft)]">— {ver.notes}</span>}
                    <p className="text-[11px] text-[var(--muted)]">{formatDateTime(ver.createdAt)}</p>
                  </div>
                  {isActive ? (
                    <StatusChip tone="success">Active</StatusChip>
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => handleActivateVersion(ver.id)}
                    >
                      Restore
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
