"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconClipboardCheck, IconExternalLink, IconSettings, IconSparkles, IconX } from "@tabler/icons-react";
import { useAppData } from "@/components/app/AppDataProvider";
import { Select } from "@/components/ui";
import { ZyraWorkspace } from "@/components/agents/ZyraWorkspace";

export function ZyraCopilotDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const { projects } = useAppData();

  const routeProjectMatch = pathname?.match(/^\/projects\/([^/]+)/);
  const routeProjectId = routeProjectMatch?.[1] ?? "";
  const [manualProjectId, setManualProjectId] = useState<string>("");

  const activeProjectId =
    (routeProjectId && projects.some((p) => p.id === routeProjectId) ? routeProjectId : "") ||
    (manualProjectId && projects.some((p) => p.id === manualProjectId) ? manualProjectId : "") ||
    projects[0]?.id ||
    "";

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const activeProject = projects.find((p) => p.id === activeProjectId);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-[var(--overlay-backdrop)] transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-over Copilot panel */}
      <aside
        role="dialog"
        aria-label="Zyra Copilot"
        className="relative z-10 flex h-full w-full max-w-[820px] flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]"
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] border border-[var(--border)] bg-[var(--surface-secondary)] text-[var(--foreground)]">
              <IconSparkles size={15} stroke={1.75} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-[var(--foreground)]">Zyra Copilot</span>
                {activeProject && projects.length <= 1 && (
                  <span className="truncate rounded-[4px] border border-[var(--border)] bg-[var(--surface-secondary)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]">
                    {activeProject.name}
                  </span>
                )}
              </div>
            </div>
            {projects.length > 1 && (
              <Select
                value={activeProjectId}
                onChange={(e) => setManualProjectId(e.target.value)}
                aria-label="Select project for Copilot"
                className="ml-1 h-8 w-auto max-w-[200px] px-2 py-1 text-xs"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.key})
                  </option>
                ))}
              </Select>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {activeProjectId && (
              <>
                <Link
                  href={`/projects/${activeProjectId}/agents/tasks`}
                  onClick={onClose}
                  title="Task board"
                  className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--border)] px-2.5 text-xs font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--surface-secondary)]"
                >
                  <IconClipboardCheck size={14} stroke={1.75} />
                  <span className="hidden sm:inline">Tasks</span>
                </Link>
                <Link
                  href={`/projects/${activeProjectId}/agents/zyra/settings`}
                  onClick={onClose}
                  title="Zyra settings"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] border border-[var(--border)] text-[var(--muted)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
                >
                  <IconSettings size={14} stroke={1.75} />
                </Link>
                <Link
                  href={`/projects/${activeProjectId}/agents/zyra`}
                  onClick={onClose}
                  title="Open full workspace"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] border border-[var(--border)] text-[var(--muted)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
                >
                  <IconExternalLink size={14} stroke={1.75} />
                </Link>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Copilot"
              className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-[var(--muted)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
            >
              <IconX size={16} stroke={1.75} />
            </button>
          </div>
        </div>

        {activeProjectId ? (
          <ZyraWorkspace
            key={activeProjectId}
            projectId={activeProjectId}
            projectName={activeProject?.name ?? ""}
            mode="drawer"
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
            <p className="text-sm font-medium text-[var(--foreground)]">No projects available</p>
            <p className="mt-1 text-xs text-[var(--muted)]">Create a project first to chat with Zyra Copilot.</p>
            <Link
              href="/projects"
              onClick={onClose}
              className="mt-4 inline-flex h-8 items-center rounded-[6px] border border-[var(--border)] bg-[var(--surface-secondary)] px-3 text-xs font-medium text-[var(--foreground)] hover:border-[var(--border-strong)]"
            >
              Go to Projects
            </Link>
          </div>
        )}
      </aside>
    </div>
  );
}
