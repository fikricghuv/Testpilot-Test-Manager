"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useParams } from "@/lib/routeParams";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentType } from "react";
import {
  IconActivity,
  IconArrowRight,
  IconBook,
  IconBug,
  IconClipboardCheck,
  IconCompass,
  IconDatabase,
  IconGitCompare,
  IconListCheck,
  IconMessage2Bolt,
  IconPlayerPlay,
  IconSettings2,
  IconShieldCheck,
  IconWand,
  IconX,
} from "@tabler/icons-react";
import { getZyraAgent, type ZyraAgentState, type ZyraCapabilities, type ZyraTask } from "@/lib/api";
import { Modal, PageLoader, StatusChip } from "@/components/ui";
import { ListWorkspaceLayout, PageHeader, Breadcrumbs } from "@/components/workflows";
import { useAppData } from "@/components/app/AppDataProvider";
import { useProjectData } from "@/components/project/ProjectDataProvider";
import { getPageCache, setPageCache } from "@/lib/pageDataCache";
import { formatDate } from "@/lib/date";

interface AgentsPageData {
  state: ZyraAgentState;
}

type ChipIcon = ComponentType<{ size?: number; stroke?: number; className?: string }>;

const CAPABILITY_META: Record<keyof ZyraCapabilities, { icon: ChipIcon; label: string }> = {
  generation: { icon: IconWand, label: "Test generation" },
  knowledgeBase: { icon: IconBook, label: "Knowledge base" },
  testcaseStorage: { icon: IconDatabase, label: "Testcase storage" },
  suiteOperations: { icon: IconListCheck, label: "Suite operations" },
  runOperations: { icon: IconPlayerPlay, label: "Run operations" },
  bugOperations: { icon: IconBug, label: "Bug operations" },
};

const futureAgents: Array<{
  name: string;
  role: string;
  summary: string;
  icon: ChipIcon;
  chips: Array<{ icon: ChipIcon; label: string }>;
}> = [
  {
    name: "Run Analyst",
    role: "Execution insight agent",
    summary: "Planned for run failure clustering, flaky-test signals, and release risk notes.",
    icon: IconActivity,
    chips: [
      { icon: IconGitCompare, label: "Failure clustering" },
      { icon: IconWand, label: "Flaky signals" },
    ],
  },
  {
    name: "Bug Triage",
    role: "Defect analysis agent",
    summary: "Planned for duplicate bug checks, severity suggestions, and owner recommendations.",
    icon: IconBug,
    chips: [
      { icon: IconGitCompare, label: "Duplicate checks" },
      { icon: IconShieldCheck, label: "Severity scoring" },
    ],
  },
];

const ACTIVE_TASK_STATUSES = new Set(["todo", "in_progress", "in_review"]);

// Absolute date only — this card must not read "Nd ago" again (it used to go stale
// silently whenever activity came from Zyra chat instead of the task board; see
// `agent.lastUsedAt` on the backend, which now accounts for both). Sitewide standard
// format (lib/date.ts) — now shared with the Zyra chat Conversations list's own
// `formatTime`, which previously kept its own "24 Aug, 08:08 pm" shape.
function formatLastUsedDate(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return formatDate(date);
}

/*
 * `testcasesCreated` comes from the API rather than being summed here.
 *
 * Basecamp 10212918496: this summed task.generatedCount, a number only the task-board draft flow
 * produces. Chat mode creates test cases directly and records no generation row, so a project whose
 * 33 cases were all made through the chat reported "0 tests generated". The backend now counts the
 * `zyra_created` audit action, which both modes write.
 */
function deriveZyraStats(tasks: ZyraTask[], testcasesCreated: number) {
  const testsGenerated = testcasesCreated;
  const activeTasks = tasks.filter((t) => ACTIVE_TASK_STATUSES.has(t.taskStatus)).length;
  return { testsGenerated, activeTasks };
}

export default function AgentsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const { currentUser } = useAppData();
  const { project } = useProjectData();
  const projectName = String(project.name || "");
  const cacheKey = `agents:${projectId}`;
  const cached = getPageCache<AgentsPageData>(cacheKey);
  const [state, setState] = useState<ZyraAgentState | null>(cached?.state ?? null);
  // Only the true first visit to this project's agents page has no cache to seed from — every
  // later visit renders the last-known data immediately while the effect below revalidates it
  // in the background, instead of blocking behind the spinner on every single click.
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const data = await getZyraAgent(projectId);
      setState(data);
      setError(null);
      setPageCache(`agents:${projectId}`, { state: data });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agents.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const key = `agents:${projectId}`;
    const existing = getPageCache<AgentsPageData>(key);
    if (existing) {
      setState(existing.state);
      setLoading(false);
    } else {
      setLoading(true);
    }
    if (!currentUser) router.replace("/login");
    else void loadData();
  }, [loadData, router, currentUser, projectId]);

  const stats = useMemo(() => (state ? deriveZyraStats(state.tasks, state.testcasesCreated ?? 0) : null), [state]);
  const capabilityChips = useMemo(() => {
    if (!state) return [];
    return (Object.keys(CAPABILITY_META) as Array<keyof ZyraCapabilities>)
      .filter((key) => state.settings.capabilities[key])
      .map((key) => CAPABILITY_META[key]);
  }, [state]);

  const agentsBreadcrumb = (
    <Breadcrumbs
      items={[
        { label: "Projects", href: "/projects" },
        { label: projectName || "Project", href: `/projects/${projectId}/dashboard` },
        { label: "Agents" },
      ]}
    />
  );

  if (loading) {
    return (
      <ListWorkspaceLayout header={<PageHeader title="Agents" breadcrumb={agentsBreadcrumb} />}>
        <PageLoader label="Loading agents…" />
      </ListWorkspaceLayout>
    );
  }

  if (!state || !stats) {
    return (
      <ListWorkspaceLayout header={<PageHeader title="Agents" breadcrumb={agentsBreadcrumb} />}>
        <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]">
          {error ?? "Failed to load agents."}
        </p>
      </ListWorkspaceLayout>
    );
  }

  return (
    <ListWorkspaceLayout
      header={
        <PageHeader
          title="Agents"
          subtitle="Select an AI agent to work with. Each agent has its own workspace, memory, and settings."
          breadcrumb={agentsBreadcrumb}
        />
      }
    >
      {error && (
        <p className="rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error-foreground)]">{error}</p>
      )}

      <div className="space-y-8">
        <section aria-labelledby="active-agents-heading">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 id="active-agents-heading" className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
              Active in this project
            </h2>
            <span className="font-mono text-xs text-[var(--muted-soft)]">2 available</span>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* Zyra */}
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="group flex h-full flex-col justify-between rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] p-5 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-secondary)]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <IconWand size={18} stroke={1.75} className="shrink-0 text-[var(--muted)]" />
                      <h3 className="text-[15px] font-semibold text-[var(--foreground)]">{state.agent.name}</h3>
                      <span className="inline-flex items-center gap-1.5 rounded-[4px] border border-[var(--border)] bg-[var(--surface-secondary)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--foreground)]">
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: state.agent.active ? "var(--status-pass-dot)" : "var(--muted-soft)" }}
                        />
                        {state.agent.active ? "Active" : "Inactive"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-[var(--muted)]">{state.agent.role}</p>
                  </div>
                  <span className="inline-flex min-h-[28px] shrink-0 items-center gap-1 text-xs font-medium text-[var(--muted)] transition-colors group-hover:text-[var(--foreground)]">
                    Open
                    <IconArrowRight size={14} stroke={1.75} />
                  </span>
                </div>

                <p className="mt-3 text-[13px] leading-relaxed text-[var(--muted)]">
                  Generates detailed testcases from stories, knowledge, Jira tickets, existing testcases, and Zyra memory.
                </p>

                {capabilityChips.length > 0 && (
                  <div className="mt-3.5 flex flex-wrap gap-1.5">
                    {capabilityChips.map(({ icon: Icon, label }) => (
                      <span
                        key={label}
                        className="inline-flex items-center gap-1.5 rounded-[4px] border border-[var(--border)] bg-[var(--surface-secondary)] px-2 py-0.5 text-[11px] text-[var(--muted)]"
                      >
                        <Icon size={12} stroke={1.75} />
                        {label}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-5 grid grid-cols-3 gap-3 border-t border-[var(--border)] pt-3.5 tabular-nums">
                <div>
                  <div className="font-mono text-sm font-semibold text-[var(--foreground)]">{stats.testsGenerated}</div>
                  <div className="text-[11px] text-[var(--muted-soft)]">Tests generated</div>
                </div>
                <div>
                  <div className="font-mono text-sm font-semibold text-[var(--foreground)]">{stats.activeTasks}</div>
                  <div className="text-[11px] text-[var(--muted-soft)]">Active tasks</div>
                </div>
                <div>
                  <div className="font-mono text-sm font-semibold text-[var(--foreground)]">
                    {state.approvalRate === null ? "--" : `${state.approvalRate}%`}
                  </div>
                  <div className="text-[11px] text-[var(--muted-soft)]">
                    {(() => {
                      const lastUsedDate = state.agent.lastUsedAt ? formatLastUsedDate(state.agent.lastUsedAt) : null;
                      return lastUsedDate ? `Used ${lastUsedDate}` : "Approval rate";
                    })()}
                  </div>
                </div>
              </div>
            </button>

            {/* NYRA */}
            {/* Plan gating lives on the NYRA page and the API, so the card is the same for every plan. */}
            <Link
              href={`/projects/${projectId}/agents/nyra`}
              data-testid="agent-card-nyra"
              className="group flex h-full flex-col justify-between rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] p-5 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-secondary)]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <IconCompass size={18} stroke={1.75} className="shrink-0 text-[var(--muted)]" />
                      <h3 className="text-[15px] font-semibold text-[var(--foreground)]">NYRA</h3>
                      <span className="rounded-[4px] border border-[var(--warning-border)] bg-[var(--warning-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--warning-foreground)]">
                        Pro
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-[var(--muted)]">App exploration agent</p>
                  </div>
                  <span className="inline-flex min-h-[28px] shrink-0 items-center gap-1 text-xs font-medium text-[var(--muted)] transition-colors group-hover:text-[var(--foreground)]">
                    Open
                    <IconArrowRight size={14} stroke={1.75} />
                  </span>
                </div>

                <p className="mt-3 text-[13px] leading-relaxed text-[var(--muted)]">
                  Explores your app, with an optional test account to sign in, and records what it finds. Each NYRA project covers one app.
                </p>
              </div>

              <div className="mt-5 flex items-center justify-between border-t border-[var(--border)] pt-3.5 text-xs text-[var(--muted-soft)]">
                <span>Autonomous app walkthroughs</span>
                <span className="font-medium text-[var(--foreground)]">Configure &amp; run</span>
              </div>
            </Link>
          </div>
        </section>

        {/* Planned agents: compact dashed rows so unshipped items don't compete with live tools */}
        <section aria-labelledby="planned-agents-heading">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 id="planned-agents-heading" className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
              Planned
            </h2>
            <span className="font-mono text-xs text-[var(--muted-soft)]">{futureAgents.length} in roadmap</span>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {futureAgents.map((agent) => (
              <div
                key={agent.name}
                className="flex items-start gap-3 rounded-[var(--radius-card)] border border-dashed border-[var(--border)] bg-[var(--surface)]/60 p-4"
              >
                <agent.icon size={18} stroke={1.75} className="mt-0.5 shrink-0 text-[var(--muted-soft)]" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium text-[var(--foreground)]">{agent.name}</h3>
                      <span className="text-xs text-[var(--muted-soft)]">{agent.role}</span>
                    </div>
                    <span className="shrink-0 rounded-[4px] border border-[var(--border)] bg-[var(--surface-secondary)] px-1.5 py-0.5 text-[11px] text-[var(--muted-soft)]">
                      Coming soon
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{agent.summary}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)}>
        <div className="-m-6">
          <div className="flex items-center gap-3.5 border-b border-[var(--border-subtle)] p-6">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-secondary)] text-[var(--foreground)]">
              <IconWand size={20} stroke={1.75} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[17px] font-semibold text-[var(--foreground)]">{state.agent.name}</span>
                <StatusChip tone={state.agent.active ? "success" : "neutral"}>{state.agent.active ? "Active" : "Inactive"}</StatusChip>
              </div>
              <div className="text-[13px] text-[var(--muted)]">{state.agent.role}</div>
            </div>
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              aria-label="Close"
              className="rounded-md p-1.5 text-[var(--muted-soft)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
            >
              <IconX size={16} stroke={1.75} />
            </button>
          </div>

          <div className="grid grid-cols-3 divide-x divide-[var(--border-subtle)] border-b border-[var(--border-subtle)]">
            <div className="p-4 text-center">
              <div className="font-mono text-xl font-semibold text-[var(--foreground)]">{stats.testsGenerated}</div>
              <div className="mt-0.5 text-[11px] text-[var(--muted-soft)]">Tests generated</div>
            </div>
            <div className="p-4 text-center">
              <div className="font-mono text-xl font-semibold text-[var(--foreground)]">{stats.activeTasks}</div>
              <div className="mt-0.5 text-[11px] text-[var(--muted-soft)]">Active tasks</div>
            </div>
            <div className="p-4 text-center">
              <div
                className="font-mono text-xl font-semibold"
                style={{ color: state.approvalRate === null ? "var(--muted-soft)" : "var(--success)" }}
              >
                {state.approvalRate === null ? "--" : `${state.approvalRate}%`}
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--muted-soft)]">Approval rate</div>
            </div>
          </div>

          <div className="space-y-2 p-5">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--muted-soft)]">Open in</p>
            <Link
              href={`/projects/${projectId}/agents/zyra`}
              className="group flex items-center justify-between rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-4 py-3 transition hover:border-[var(--brand-primary)]"
            >
              <div className="flex items-center gap-3">
                <IconMessage2Bolt size={20} stroke={1.75} className="text-[var(--accent-light)]" />
                <div>
                  <div className="text-[13px] font-medium text-[var(--foreground)]">Agent workspace</div>
                  <div className="text-[12px] text-[var(--muted)]">Chat with {state.agent.name} and manage pending tasks</div>
                </div>
              </div>
              <IconArrowRight size={16} stroke={1.75} className="text-[var(--muted-soft)] transition-colors group-hover:text-[var(--accent-light)]" />
            </Link>
            <Link
              href={`/projects/${projectId}/agents/tasks`}
              className="group flex items-center justify-between rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-4 py-3 transition hover:border-[var(--brand-primary)]"
            >
              <div className="flex items-center gap-3">
                <IconClipboardCheck size={20} stroke={1.75} className="text-[var(--accent-light)]" />
                <div>
                  <div className="text-[13px] font-medium text-[var(--foreground)]">Task board</div>
                  <div className="text-[12px] text-[var(--muted)]">Review and approve generated test cases</div>
                </div>
              </div>
              <IconArrowRight size={16} stroke={1.75} className="text-[var(--muted-soft)] transition-colors group-hover:text-[var(--accent-light)]" />
            </Link>
            <Link
              href={`/projects/${projectId}/agents/zyra/settings`}
              className="group flex items-center justify-between rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-4 py-3 transition hover:border-[var(--brand-primary)]"
            >
              <div className="flex items-center gap-3">
                <IconSettings2 size={20} stroke={1.75} className="text-[var(--muted-soft)]" />
                <div>
                  <div className="text-[13px] font-medium text-[var(--foreground)]">Settings</div>
                  <div className="text-[12px] text-[var(--muted)]">Configure sources, memory, and behaviour</div>
                </div>
              </div>
              <IconArrowRight size={16} stroke={1.75} className="text-[var(--muted-soft)] transition-colors group-hover:text-[var(--accent-light)]" />
            </Link>
          </div>
        </div>
      </Modal>
    </ListWorkspaceLayout>
  );
}
