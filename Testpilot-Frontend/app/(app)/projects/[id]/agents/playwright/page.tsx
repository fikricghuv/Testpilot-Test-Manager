"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "@/lib/routeParams";
import {
  IconCheck,
  IconKey,
  IconLoader2,
  IconRadar2,
  IconSparkles,
  IconWand,
} from "@tabler/icons-react";
import {
  createTestCasesFromExplore,
  getAutomationAgentJob,
  getAutomationAuthConfig,
  listAutomationAgentJobs,
  saveAutomationAuthConfig,
  startAutomationExplore,
  type AutomationAuthConfigSummary,
  type TestAgentJobRecord,
} from "@/lib/api";
import { Button, Card, Field, FieldLabel, Input, StatusChip } from "@/components/ui";
import { Breadcrumbs, ListWorkspaceLayout, PageHeader } from "@/components/workflows";
import { useProjectData } from "@/components/project/ProjectDataProvider";

export default function PlaywrightAgentsPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const { project } = useProjectData();

  const [targetUrl, setTargetUrl] = useState("");
  const [instructions, setInstructions] = useState("");
  const [exploring, setExploring] = useState(false);
  const [activeJob, setActiveJob] = useState<TestAgentJobRecord | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [creatingCases, setCreatingCases] = useState(false);
  const [jobs, setJobs] = useState<TestAgentJobRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [authSummary, setAuthSummary] = useState<AutomationAuthConfigSummary | null>(null);
  const [loginUrl, setLoginUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [storageStateJson, setStorageStateJson] = useState("");
  const [savingAuth, setSavingAuth] = useState(false);

  const loadInitial = useCallback(async () => {
    if (!projectId) return;
    try {
      const [authRes, jobsRes] = await Promise.all([
        getAutomationAuthConfig(projectId),
        listAutomationAgentJobs(projectId),
      ]);
      setAuthSummary(authRes);
      setLoginUrl(authRes.loginUrl ?? "");
      setUsername(authRes.username ?? "");
      setJobs(jobsRes.list);
    } catch {
      // Ignore initial load error
    }
  }, [projectId]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (!activeJob || activeJob.stage === "completed" || activeJob.stage === "failed") return;
    const timer = setTimeout(async () => {
      try {
        const res = await getAutomationAgentJob(projectId, activeJob.id);
        setActiveJob(res.job);
        if (res.job.stage === "completed") {
          setExploring(false);
          setSelectedIndices(res.job.discoveredScenarios.map((_, i) => i));
          void loadInitial();
        } else if (res.job.stage === "failed") {
          setExploring(false);
          setError(res.job.errorMessage || "Explore job failed.");
          void loadInitial();
        }
      } catch {
        setExploring(false);
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [activeJob, projectId, loadInitial]);

  async function handleExplore() {
    if (!targetUrl.trim()) {
      setError("Enter a Target URL to explore.");
      return;
    }
    setExploring(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await startAutomationExplore(projectId, {
        targetUrl: targetUrl.trim(),
        instructions: instructions.trim() || null,
      });
      setActiveJob(res.job);
    } catch (err) {
      setExploring(false);
      setError(err instanceof Error ? err.message : "Failed to start Explorer agent.");
    }
  }

  async function handleCreateCases() {
    if (!activeJob || selectedIndices.length === 0) return;
    setCreatingCases(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await createTestCasesFromExplore(projectId, activeJob.id, selectedIndices);
      setSuccess(
        `Created ${res.created.length} test case(s) and queued 3-Agent Playwright generation + verification for each.`
      );
      void loadInitial();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create test cases.");
    } finally {
      setCreatingCases(false);
    }
  }

  async function handleSaveAuth() {
    setSavingAuth(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await saveAutomationAuthConfig(projectId, {
        loginUrl: loginUrl.trim() || null,
        username: username.trim() || null,
        ...(password ? { password } : {}),
        ...(storageStateJson.trim() ? { storageStateJson: storageStateJson.trim() } : {}),
      });
      setAuthSummary(updated);
      setPassword("");
      setStorageStateJson("");
      setSuccess("Encrypted project authentication profile saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save auth profile.");
    } finally {
      setSavingAuth(false);
    }
  }

  return (
    <ListWorkspaceLayout
      header={
        <PageHeader
          title="Playwright 3-Agent Automation"
          subtitle="Planner inspects live DOM/ARIA, Generator writes grounded Playwright TypeScript, and Healer auto-fixes until verified."
          breadcrumb={
            <Breadcrumbs
              items={[
                { label: typeof project?.name === "string" ? project.name : "Project", href: `/projects/${projectId}` },
                { label: "Agents", href: `/projects/${projectId}/agents` },
                { label: "Playwright 3-Agent" },
              ]}
            />
          }
        />
      }
    >
      <div className="space-y-6">
        {error && (
          <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]">
            {error}
          </p>
        )}
        {success && (
          <p className="rounded-lg border border-[var(--success)]/40 bg-[var(--surface)] px-3 py-2 text-sm text-[var(--success-foreground)]">
            {success}
          </p>
        )}

        {/* Explorer Agent */}
        <Card className="p-5 space-y-4">
          <div className="flex items-center gap-2">
            <IconRadar2 size={18} className="text-[var(--brand-primary)]" />
            <h2 className="text-sm font-semibold">Autonomous Page Explorer (Planner)</h2>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field>
              <FieldLabel>Target URL</FieldLabel>
              <Input
                type="url"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="https://staging.yourapp.com/login"
              />
            </Field>
            <Field>
              <FieldLabel>Scope / Instructions (optional)</FieldLabel>
              <Input
                type="text"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="e.g. Focus on login validation and error states"
              />
            </Field>
          </div>
          <div className="flex items-center gap-3">
            <Button type="button" variant="primary" size="sm" onClick={handleExplore} disabled={exploring}>
              {exploring ? <IconLoader2 size={14} className="animate-spin" /> : <IconSparkles size={14} />}
              {exploring ? "Exploring Live DOM..." : "Explore & Discover Scenarios"}
            </Button>
            {activeJob && (
              <StatusChip tone={activeJob.stage === "failed" ? "error" : activeJob.stage === "completed" ? "success" : "warning"}>
                {activeJob.stage}
              </StatusChip>
            )}
          </div>

          {activeJob?.discoveredScenarios && activeJob.discoveredScenarios.length > 0 && (
            <div className="space-y-3 border-t border-[var(--border-subtle)] pt-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
                  Discovered Scenarios ({activeJob.discoveredScenarios.length})
                </span>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={handleCreateCases}
                  disabled={creatingCases || selectedIndices.length === 0}
                >
                  {creatingCases ? <IconLoader2 size={14} className="animate-spin" /> : <IconWand size={14} />}
                  Create {selectedIndices.length} Test Case(s) &amp; Generate Scripts
                </Button>
              </div>
              <div className="space-y-2">
                {activeJob.discoveredScenarios.map((sc, idx) => {
                  const checked = selectedIndices.includes(idx);
                  return (
                    <label
                      key={idx}
                      className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--background)] p-3"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedIndices((prev) =>
                            prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx]
                          )
                        }
                        className="mt-1"
                      />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{sc.title}</span>
                          <StatusChip tone="neutral">{sc.priority}</StatusChip>
                        </div>
                        {sc.description && <p className="text-xs text-[var(--muted)]">{sc.description}</p>}
                        {sc.steps.length > 0 && (
                          <p className="font-mono text-[11px] text-[var(--muted)]">
                            {sc.steps.join(" → ")}
                          </p>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </Card>

        {/* Project Auth Config */}
        <Card className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <IconKey size={18} className="text-[var(--brand-primary)]" />
              <h2 className="text-sm font-semibold">Authenticated Pages Profile (Encrypted)</h2>
            </div>
            <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
              {authSummary?.hasPassword && <StatusChip tone="success">Credentials Saved</StatusChip>}
              {authSummary?.hasStorageState && <StatusChip tone="success">storageState Saved</StatusChip>}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field>
              <FieldLabel>Login URL (optional)</FieldLabel>
              <Input value={loginUrl} onChange={(e) => setLoginUrl(e.target.value)} placeholder="https://app.example.com/login" />
            </Field>
            <Field>
              <FieldLabel>Username / Email</FieldLabel>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="qa@example.com" />
            </Field>
            <Field>
              <FieldLabel>Password (leave blank to keep)</FieldLabel>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </Field>
          </div>
          <Field>
            <FieldLabel>Playwright storageState JSON (optional, overrides credentials)</FieldLabel>
            <textarea
              value={storageStateJson}
              onChange={(e) => setStorageStateJson(e.target.value)}
              rows={3}
              placeholder='{"cookies":[...],"origins":[...]}'
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] p-2.5 font-mono text-xs"
            />
          </Field>
          <Button type="button" variant="secondary" size="sm" onClick={handleSaveAuth} disabled={savingAuth}>
            {savingAuth ? <IconLoader2 size={14} className="animate-spin" /> : <IconCheck size={14} />}
            Save Auth Profile
          </Button>
        </Card>

        {/* Recent Jobs */}
        <Card className="p-5 space-y-3">
          <h2 className="text-sm font-semibold">Recent 3-Agent Jobs</h2>
          {jobs.length === 0 ? (
            <p className="text-xs text-[var(--muted)]">No 3-Agent jobs run in this project yet.</p>
          ) : (
            <div className="divide-y divide-[var(--border-subtle)]">
              {jobs.map((j) => (
                <div key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-xs">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusChip tone={j.stage === "completed" ? "success" : j.stage === "failed" ? "error" : "warning"}>
                        {j.stage}
                      </StatusChip>
                      <span className="font-mono">{j.mode}</span>
                      <span className="truncate text-[var(--muted)]">{j.targetUrl}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-[var(--muted)]">
                    {j.attempt > 0 && <span>Attempt {j.attempt}/{j.maxAttempts}</span>}
                    {j.testcaseId && (
                      <Link href={`/projects/${projectId}/testcases/${j.testcaseId}`} className="text-[var(--brand-primary)] underline">
                        Open Test Case
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </ListWorkspaceLayout>
  );
}
