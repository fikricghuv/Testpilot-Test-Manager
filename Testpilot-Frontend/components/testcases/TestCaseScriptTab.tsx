"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconBug,
  IconCheck,
  IconCode,
  IconDeviceFloppy,
  IconDownload,
  IconHistory,
  IconLoader2,
  IconPlayerPlay,
  IconPlayerRecord,
  IconRefresh,
  IconSparkles,
  IconTrash,
  IconWand,
  IconX,
} from "@tabler/icons-react";
import {
  API_BASE,
  activateTestCaseScriptVersion,
  createTestCaseRecorderSession,
  deleteTestCaseScript,
  deleteTestCaseScriptVersion,
  getAutomationAgentJob,
  getTestCaseScript,
  getTestCaseScriptRun,
  runTestCaseScript,
  saveTestCaseScript,
  startTestCaseAiGenerate,
  startTestCaseAiHeal,
  type TestAgentJobRecord,
  type TestScriptBrowser,
  type TestScriptRunRecord,
  type TestScriptStateResponse,
  type TestScriptStatus,
} from "@/lib/api";
import { Button, CopyButton, Field, FieldLabel, Input, Modal, StatusChip } from "@/components/ui";
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
  const [runMode, setRunMode] = useState<"headless" | "headed">("headless");
  const [selectedBrowser, setSelectedBrowser] = useState<TestScriptBrowser>("chromium");
  const [launchingRecorder, setLaunchingRecorder] = useState(false);
  const [extensionReady, setExtensionReady] = useState(false);
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [checkingExtension, setCheckingExtension] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [scriptContent, setScriptContent] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [status, setStatus] = useState<TestScriptStatus>("draft");
  const [notes, setNotes] = useState("");
  const [dirty, setDirty] = useState(false);

  const [activeRun, setActiveRun] = useState<TestScriptRunRecord | null>(null);
  const [agentJob, setAgentJob] = useState<TestAgentJobRecord | null>(null);
  const [startingAgent, setStartingAgent] = useState(false);
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
      } else if (
        event.data.type === "TESTPILOT_HEADED_RUN_REPORTED" &&
        event.data.projectId === projectId &&
        event.data.testcaseId === testcaseId
      ) {
        void loadScript();
        setSuccess(
          event.data.status === "passed"
            ? "Headed Chrome run passed and report was generated."
            : "Headed Chrome run finished with failures and report was generated."
        );
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

  useEffect(() => {
    if (!agentJob || agentJob.stage === "completed" || agentJob.stage === "failed") return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await getAutomationAgentJob(projectId, agentJob.id);
        if (cancelled) return;
        setAgentJob(res.job);
        if (res.job.stage === "completed" || res.job.stage === "failed") {
          await loadScript();
          if (res.job.stage === "completed") {
            setSuccess("3-Agent pipeline verified and saved the Playwright script.");
          } else if (res.job.errorMessage) {
            setError(res.job.errorMessage);
          }
        }
      } catch {
        // Ignore transient poll error
      }
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [agentJob, projectId, loadScript]);

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

  const recheckExtension = useCallback(async (): Promise<boolean> => {
    setCheckingExtension(true);
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          window.removeEventListener("message", onPong);
          resolve(false);
        }, 600);
        function onPong(event: MessageEvent) {
          if (event.source !== window || event.data?.type !== "TESTPILOT_RECORDER_PONG") return;
          clearTimeout(timeout);
          window.removeEventListener("message", onPong);
          resolve(true);
        }
        window.addEventListener("message", onPong);
        window.postMessage({ type: "TESTPILOT_RECORDER_PING" }, "*");
      });
      setExtensionReady(ok);
      if (ok) setShowInstallModal(false);
      return ok;
    } finally {
      setCheckingExtension(false);
    }
  }, []);

  async function handleRun() {
    if (!extensionReady && !(await recheckExtension())) {
      setShowInstallModal(true);
      return;
    }
    if (runMode === "headed") {
      await handleDebugInExtension(true);
      return;
    }
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
        browser: selectedBrowser,
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

  async function handleAiGenerate() {
    const trimmedUrl = targetUrl.trim();
    if (!trimmedUrl) {
      setError("Enter a Target URL below before running the 3-Agent generator.");
      return;
    }
    setStartingAgent(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await startTestCaseAiGenerate(projectId, testcaseId, { targetUrl: trimmedUrl });
      setAgentJob(res.job);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start 3-Agent pipeline.");
    } finally {
      setStartingAgent(false);
    }
  }

  async function handleAiHeal() {
    setStartingAgent(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await startTestCaseAiHeal(projectId, testcaseId, {
        targetUrl: targetUrl.trim() || null,
      });
      setAgentJob(res.job);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start Healer agent.");
    } finally {
      setStartingAgent(false);
    }
  }

  async function handleLaunchRecorder() {
    if (!extensionReady && !(await recheckExtension())) {
      setShowInstallModal(true);
      return;
    }
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

  async function handleDebugInExtension(autoRun = false) {
    if (!extensionReady && !(await recheckExtension())) {
      setShowInstallModal(true);
      return;
    }
    if (!scriptContent.trim()) {
      setError("Write or record a Playwright spec before debugging.");
      return;
    }
    setLaunchingRecorder(true);
    setError(null);
    setSuccess(null);
    try {
      let session: { apiBaseUrl: string; token: string; projectId: string } | null = null;
      if (autoRun) {
        if (dirty) {
          const updated = await saveTestCaseScript(projectId, testcaseId, {
            scriptContent,
            framework: "playwright-ts",
            targetUrl: targetUrl.trim() || null,
            status,
            notes: notes.trim() || "Auto-saved before headed run",
          });
          applyLoadedState(updated);
        }
        const issued = await createTestCaseRecorderSession(projectId, testcaseId);
        session = {
          apiBaseUrl: API_BASE,
          token: issued.token,
          projectId: issued.projectId,
        };
      }

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
              apiBaseUrl: session?.apiBaseUrl || null,
              token: session?.token || null,
              projectId: session?.projectId || null,
              testcaseId,
              testcaseTitle,
              testcaseExternalId,
              targetUrl: targetUrl.trim() || null,
              scriptContent,
              autoRun,
            },
          },
          "*"
        );
      });

      if (!ack.ok) {
        setError(ack.error || "Failed to launch Chrome Extension runner.");
        return;
      }
      setExtensionReady(true);
      setSuccess(
        autoRun
          ? "Playwright started in visible Chrome tab via Extension. Report will appear when execution completes."
          : "Step-by-Step Debugger opened in a new Chrome tab."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch Chrome Extension runner.");
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
              {extensionReady ? (
                <StatusChip tone="success">Extension Connected</StatusChip>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowInstallModal(true)}
                  className="inline-flex items-center"
                  title="Click to install TestPilot Chrome Extension"
                >
                  <StatusChip tone="warning">Extension Required</StatusChip>
                </button>
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
            onClick={handleAiGenerate}
            disabled={startingAgent || Boolean(agentJob && agentJob.stage !== "completed" && agentJob.stage !== "failed")}
            title="Planner inspects live DOM/ARIA, Generator writes grounded spec, Healer verifies"
          >
            {startingAgent || (agentJob && agentJob.stage !== "completed" && agentJob.stage !== "failed") ? (
              <IconLoader2 size={14} className="animate-spin" />
            ) : (
              <IconSparkles size={14} />
            )}
            Generate with AI (3-Agent)
          </Button>
          {activeRun && (activeRun.status === "failed" || activeRun.status === "error") && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleAiHeal}
              disabled={startingAgent || Boolean(agentJob && agentJob.stage !== "completed" && agentJob.stage !== "failed")}
              title="Analyze failure and auto-fix with Healer agent"
            >
              <IconWand size={14} />
              Heal with AI
            </Button>
          )}
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
            onClick={() => handleDebugInExtension(false)}
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
            disabled={saving || !dirty || !scriptContent.trim()}
          >
            <IconDeviceFloppy size={14} />
            {saving ? "Saving..." : "Save Script"}
          </Button>
          <div className="inline-flex items-center overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
            <select
              value={runMode}
              onChange={(e) => setRunMode(e.target.value as "headless" | "headed")}
              aria-label="Playwright run mode"
              className="h-8 bg-transparent px-2 text-xs font-medium text-[var(--foreground)] focus:outline-none"
            >
              <option value="headless">Headless (Server)</option>
              <option value="headed">Headed (Extension)</option>
            </select>
            {runMode === "headless" && (
              <select
                value={selectedBrowser}
                onChange={(e) => setSelectedBrowser(e.target.value as TestScriptBrowser)}
                aria-label="Playwright browser"
                className="h-8 border-l border-[var(--border)] bg-transparent px-2 text-xs font-medium text-[var(--foreground)] focus:outline-none"
              >
                <option value="chromium">Chromium</option>
                <option value="firefox">Firefox</option>
                <option value="webkit">WebKit (Safari)</option>
                <option value="all">All Browsers</option>
              </select>
            )}
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleRun}
              disabled={(runMode === "headless" ? isRunning : launchingRecorder) || !scriptContent.trim()}
              className="rounded-none border-l border-[var(--border)]"
            >
              {(runMode === "headless" ? isRunning : launchingRecorder) ? (
                <IconLoader2 size={14} className="animate-spin" />
              ) : (
                <IconPlayerPlay size={14} />
              )}
              {runMode === "headless"
                ? isRunning
                  ? "Running..."
                  : "Run Playwright"
                : launchingRecorder
                  ? "Launching..."
                  : "Run in Chrome"}
            </Button>
          </div>
        </div>
      </div>

      {/* Live 3-Agent Pipeline Stepper */}
      {agentJob && (
        <div className="space-y-3 rounded-xl border border-[var(--brand-primary)]/40 bg-[var(--background)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <IconSparkles size={16} className="text-[var(--brand-primary)]" />
              <span className="text-xs font-semibold uppercase tracking-wider">3-Agent Pipeline ({agentJob.mode})</span>
              <StatusChip
                tone={
                  agentJob.stage === "completed"
                    ? "success"
                    : agentJob.stage === "failed"
                      ? "error"
                      : "warning"
                }
              >
                {agentJob.stage}
              </StatusChip>
              {agentJob.attempt > 0 && (
                <span className="text-xs text-[var(--muted)]">
                  Attempt {agentJob.attempt}/{agentJob.maxAttempts}
                </span>
              )}
            </div>
            {(agentJob.stage === "completed" || agentJob.stage === "failed") && (
              <button
                type="button"
                onClick={() => setAgentJob(null)}
                className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                Dismiss
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 text-xs">
            {[
              { key: "planning", label: "1. Planner (ARIA Inspect)" },
              { key: "generating", label: "2. Generator (Playwright TS)" },
              { key: "healing", label: "3. Healer (Verify & Fix)" },
            ].map((step, idx) => {
              const stageOrder = ["queued", "planning", "generating", "running", "healing", "completed"];
              const curIdx = stageOrder.indexOf(agentJob.stage);
              const stepIdx = idx === 0 ? 1 : idx === 1 ? 2 : 3;
              const isDone = agentJob.stage === "completed" || curIdx > stepIdx;
              const isActive =
                (idx === 0 && agentJob.stage === "planning") ||
                (idx === 1 && agentJob.stage === "generating") ||
                (idx === 2 && (agentJob.stage === "running" || agentJob.stage === "healing"));
              return (
                <div
                  key={step.key}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                    isActive
                      ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/10"
                      : isDone
                        ? "border-[var(--success)]/40 bg-[var(--surface)]"
                        : "border-[var(--border-subtle)] bg-[var(--surface)] opacity-70"
                  }`}
                >
                  {isActive ? (
                    <IconLoader2 size={14} className="shrink-0 animate-spin text-[var(--brand-primary)]" />
                  ) : isDone ? (
                    <IconCheck size={14} className="shrink-0 text-[var(--success)]" />
                  ) : agentJob.stage === "failed" ? (
                    <IconX size={14} className="shrink-0 text-[var(--error)]" />
                  ) : (
                    <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--muted)]" />
                  )}
                  <span className="font-medium">{step.label}</span>
                </div>
              );
            })}
          </div>

          {agentJob.logs.length > 0 && (
            <div className="max-h-28 overflow-y-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-2.5 font-mono text-[11px] text-[var(--muted)] space-y-1">
              {agentJob.logs.slice(-6).map((l, i) => (
                <div key={i}>
                  <span className="text-[var(--foreground)]">[{l.stage}]</span> {l.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
      {showInstallModal && (
        <Modal
          open={showInstallModal}
          onClose={() => setShowInstallModal(false)}
          title="TestPilot Chrome Extension Required"
        >
          <div className="space-y-4 text-sm text-[var(--foreground)]">
            <p className="text-[var(--muted)]">
              Untuk merekam, debug, atau menjalankan Playwright dari halaman ini, kamu wajib memasang ekstensi{" "}
              <strong className="text-[var(--foreground)]">TestPilot Web Recorder</strong> di Chrome.
            </p>
            <ol className="list-decimal space-y-2 pl-5 text-xs leading-relaxed text-[var(--muted)]">
              <li>
                Klik <strong className="text-[var(--foreground)]">Download Extension (.zip)</strong> di bawah lalu ekstrak foldernya.
              </li>
              <li>
                Buka <code className="rounded bg-[var(--surface-secondary)] px-1.5 py-0.5 font-mono">chrome://extensions/</code> di Chrome dan aktifkan{" "}
                <strong className="text-[var(--foreground)]">Developer mode</strong>.
              </li>
              <li>
                Klik <strong className="text-[var(--foreground)]">Load unpacked</strong>, pilih folder hasil ekstrak, lalu klik{" "}
                <strong className="text-[var(--foreground)]">Re-check Connection</strong> (atau refresh halaman ini).
              </li>
            </ol>
            <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
              <a
                href="/downloads/testpilot-web-recorder.zip"
                download="testpilot-web-recorder.zip"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--brand-primary)] px-3 text-xs font-medium text-white transition-opacity hover:opacity-90"
              >
                <IconDownload size={14} />
                Download Extension (.zip)
              </a>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void recheckExtension()}
                disabled={checkingExtension}
              >
                {checkingExtension ? <IconLoader2 size={14} className="animate-spin" /> : <IconRefresh size={14} />}
                Re-check Connection
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
