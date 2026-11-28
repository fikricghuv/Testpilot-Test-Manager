"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconBug,
  IconCheck,
  IconExternalLink,
  IconLoader2,
  IconPaperclip,
  IconPhoto,
} from "@tabler/icons-react";
import {
  updateExecution,
  uploadExecutionEvidence,
  type ExecutionItem,
} from "@/lib/api";

const EXECUTION_STATUSES = [
  "Untested",
  "Passed",
  "Failed",
  "Blocked",
  "Skipped",
  "Retest",
] as const;

function statusSelectStyle(status: string): string {
  switch (status) {
    case "Passed":
      return "border-[var(--success-foreground,#15803D)]/40 bg-[var(--success-soft,#DCFCE7)] text-[var(--success-foreground,#15803D)]";
    case "Failed":
      return "border-[var(--error-foreground,#B91C1C)]/40 bg-[var(--error-soft,#FEE2E2)] text-[var(--error-foreground,#B91C1C)]";
    case "Blocked":
      return "border-[var(--warning-foreground,#B45309)]/40 bg-[var(--warning-soft,#FEF3C7)] text-[var(--warning-foreground,#B45309)]";
    case "Retest":
      return "border-[var(--brand-primary)]/40 bg-[var(--brand-soft)] text-[var(--accent-light)]";
    default:
      return "border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]";
  }
}

export type CycleExecutionGridProps = {
  cycleId: string;
  executions: ExecutionItem[];
  isCompleted: boolean;
  statusSaving: string | null;
  linkedBugsByExecId: Map<string, Array<{ bugKey: string; title: string }>>;
  onStatusChange: (executionId: string, newStatus: string) => Promise<void> | void;
  onPatchExecutionLocal: (executionId: string, patch: Partial<ExecutionItem>) => void;
  onOpenDetail: (execution: ExecutionItem) => void;
  onLogBug: (execution: ExecutionItem) => void;
  onEvidenceUploaded: (executionId: string, newTotal: number) => void;
};

type EditableExecField = "actualResult" | "defectKey";

export function CycleExecutionGrid({
  cycleId,
  executions,
  isCompleted,
  statusSaving,
  linkedBugsByExecId,
  onStatusChange,
  onPatchExecutionLocal,
  onOpenDetail,
  onLogBug,
  onEvidenceUploaded,
}: CycleExecutionGridProps) {
  const [editingCell, setEditingCell] = useState<{
    execId: string;
    field: EditableExecField;
  } | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [uploadingExecId, setUploadingExecId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetExecIdRef = useRef<string | null>(null);
  const savedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
    };
  }, []);

  const markSaved = useCallback(() => {
    setSaveState("saved");
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => setSaveState("idle"), 2000);
  }, []);

  const persistExecField = useCallback(
    async (exec: ExecutionItem, field: EditableExecField, value: string) => {
      setSaveState("saving");
      setSaveError(null);
      onPatchExecutionLocal(exec.id, { [field]: value });
      try {
        await updateExecution(cycleId, exec.id, { [field]: value });
        markSaved();
      } catch (err) {
        setSaveState("error");
        setSaveError(err instanceof Error ? err.message : "Failed to save execution");
        onPatchExecutionLocal(exec.id, { [field]: exec[field] });
      }
    },
    [cycleId, markSaved, onPatchExecutionLocal]
  );

  const startEditing = useCallback((exec: ExecutionItem, field: EditableExecField) => {
    if (isCompleted) return;
    setActiveRowId(exec.id);
    setEditingCell({ execId: exec.id, field });
    setEditDraft(exec[field] ?? "");
  }, [isCompleted]);

  const commitEditing = useCallback(
    async (move?: "down" | "next" | "prev") => {
      if (!editingCell) return;
      const idx = executions.findIndex((e) => e.id === editingCell.execId);
      const exec = idx >= 0 ? executions[idx] : null;
      const field = editingCell.field;
      const trimmed = editDraft.trim();
      setEditingCell(null);

      if (exec && trimmed !== (exec[field] ?? "")) {
        await persistExecField(exec, field, trimmed);
      }

      if (idx >= 0 && move) {
        if (move === "down" && idx + 1 < executions.length) {
          startEditing(executions[idx + 1], field);
        } else if (move === "next") {
          if (field === "actualResult") {
            startEditing(executions[idx], "defectKey");
          } else if (idx + 1 < executions.length) {
            startEditing(executions[idx + 1], "actualResult");
          }
        } else if (move === "prev") {
          if (field === "defectKey") {
            startEditing(executions[idx], "actualResult");
          } else if (idx > 0) {
            startEditing(executions[idx - 1], "defectKey");
          }
        }
      }
    },
    [editDraft, editingCell, executions, persistExecField, startEditing]
  );

  const handleUploadFiles = useCallback(
    async (executionId: string, files: File[]) => {
      if (files.length === 0 || isCompleted) return;
      setUploadingExecId(executionId);
      setSaveError(null);
      try {
        const res = await uploadExecutionEvidence(cycleId, executionId, files);
        onEvidenceUploaded(executionId, res.total);
        markSaved();
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Failed to upload evidence");
      } finally {
        setUploadingExecId(null);
      }
    },
    [cycleId, isCompleted, markSaved, onEvidenceUploaded]
  );

  const handleRowPaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      if (isCompleted || !activeRowId) return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageFiles = items
        .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f);
      if (imageFiles.length === 0) return;
      e.preventDefault();
      void handleUploadFiles(activeRowId, imageFiles);
    },
    [activeRowId, handleUploadFiles, isCompleted]
  );

  return (
    <div className="flex flex-col outline-none" tabIndex={0} onPaste={handleRowPaste}>
      {/* Helper bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface-secondary)] px-4 py-1.5 text-[11.5px] text-[var(--muted)]">
        <div className="flex flex-wrap items-center gap-3">
          <span>
            Execution Grid &middot; Click row + <kbd className="rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5 text-[10px]">Ctrl+V</kbd> to paste screenshot evidence &middot;{" "}
            <kbd className="rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5 text-[10px]">Enter</kbd> next row
          </span>
          {saveState === "saving" && (
            <span className="inline-flex items-center gap-1 text-[var(--brand-primary)]">
              <IconLoader2 size={12} stroke={2} className="animate-spin" />
              Saving…
            </span>
          )}
          {saveState === "saved" && (
            <span className="inline-flex items-center gap-1 text-[var(--success-foreground,#15803D)]">
              <IconCheck size={12} stroke={2.5} />
              Saved
            </span>
          )}
          {saveError && <span className="text-[var(--error-foreground)]">{saveError}</span>}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.pdf,.txt,.log,.zip"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          const targetId = uploadTargetExecIdRef.current;
          e.target.value = "";
          if (targetId && files.length > 0) {
            void handleUploadFiles(targetId, files);
          }
        }}
      />

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1040px] border-collapse text-left text-[12.5px]">
          <thead className="border-b border-[var(--border)] bg-[var(--surface-secondary)] text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-soft)]">
            <tr>
              <th className="w-10 border-r border-[var(--border)] px-2 py-2 text-center">#</th>
              <th className="w-[165px] border-r border-[var(--border)] px-2.5 py-2">Test Case ID</th>
              <th className="min-w-[240px] border-r border-[var(--border)] px-2.5 py-2">Scenario / Test Case</th>
              <th className="w-[125px] border-r border-[var(--border)] px-2.5 py-2">Result</th>
              <th className="min-w-[230px] border-r border-[var(--border)] px-2.5 py-2">Actual Result</th>
              <th className="w-[160px] border-r border-[var(--border)] px-2.5 py-2">Defect ID / Link</th>
              <th className="w-[130px] border-r border-[var(--border)] px-2.5 py-2">Evidence</th>
              <th className="w-14 px-2 py-2 text-center">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {executions.map((exec, idx) => {
              const isRowActive = activeRowId === exec.id;
              const isEditingActual =
                editingCell?.execId === exec.id && editingCell.field === "actualResult";
              const isEditingDefect =
                editingCell?.execId === exec.id && editingCell.field === "defectKey";
              const linkedBugs = linkedBugsByExecId.get(exec.id) ?? [];
              const evidenceCount = exec.evidenceCount ?? 0;

              return (
                <tr
                  key={exec.id}
                  onClick={() => setActiveRowId(exec.id)}
                  className={`transition-colors ${
                    isRowActive ? "bg-[var(--brand-soft)]/50" : "hover:bg-[var(--surface-secondary)]/60"
                  }`}
                >
                  <td className="border-r border-[var(--border)] px-2 py-1.5 text-center text-[11px] text-[var(--muted-soft)]">
                    {idx + 1}
                  </td>
                  <td className="border-r border-[var(--border)] px-2.5 py-1.5 font-mono text-[11.5px] text-[var(--foreground)]">
                    <span className="block truncate">{exec.externalId}</span>
                  </td>
                  <td className="border-r border-[var(--border)] px-2.5 py-1.5 font-medium text-[var(--foreground)]">
                    <button
                      type="button"
                      onClick={() => onOpenDetail(exec)}
                      className="block w-full truncate text-left hover:text-[var(--accent-light)] hover:underline"
                      title={exec.snapshotTitle || exec.title}
                    >
                      {exec.snapshotTitle || exec.title}
                    </button>
                  </td>

                  {/* Result */}
                  <td className="border-r border-[var(--border)] px-1.5 py-1">
                    <select
                      value={exec.status}
                      disabled={isCompleted || statusSaving === exec.id}
                      onChange={(e) => void onStatusChange(exec.id, e.target.value)}
                      className={`w-full cursor-pointer rounded border px-1.5 py-1 text-[12px] font-medium outline-none disabled:opacity-60 ${statusSelectStyle(
                        exec.status
                      )}`}
                    >
                      {EXECUTION_STATUSES.map((s) => (
                        <option key={s} value={s} className="bg-[var(--background)] text-[var(--foreground)]">
                          {s}
                        </option>
                      ))}
                    </select>
                  </td>

                  {/* Actual Result */}
                  <td
                    onClick={() => !isEditingActual && startEditing(exec, "actualResult")}
                    className="cursor-text border-r border-[var(--border)] px-2 py-1 text-[var(--foreground)]"
                  >
                    {isEditingActual ? (
                      <input
                        autoFocus
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onBlur={() => void commitEditing()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void commitEditing("down");
                          } else if (e.key === "Tab") {
                            e.preventDefault();
                            void commitEditing(e.shiftKey ? "prev" : "next");
                          } else if (e.key === "Escape") {
                            setEditingCell(null);
                          }
                        }}
                        placeholder="Type actual result..."
                        className="w-full rounded border border-[var(--brand-primary)] bg-[var(--background)] px-1.5 py-0.5 text-[12px] outline-none"
                      />
                    ) : (
                      <span className="block truncate text-[12px] text-[var(--muted)]">
                        {exec.actualResult || (
                          <span className="opacity-35">Click to add actual result…</span>
                        )}
                      </span>
                    )}
                  </td>

                  {/* Defect ID / Log Bug */}
                  <td className="border-r border-[var(--border)] px-2 py-1">
                    <div className="flex items-center justify-between gap-1">
                      {isEditingDefect ? (
                        <input
                          autoFocus
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onBlur={() => void commitEditing()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void commitEditing("down");
                            } else if (e.key === "Tab") {
                              e.preventDefault();
                              void commitEditing(e.shiftKey ? "prev" : "next");
                            } else if (e.key === "Escape") {
                              setEditingCell(null);
                            }
                          }}
                          placeholder="e.g. BUG-12"
                          className="w-full rounded border border-[var(--brand-primary)] bg-[var(--background)] px-1.5 py-0.5 font-mono text-[11.5px] outline-none"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEditing(exec, "defectKey")}
                          className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-[var(--muted)] hover:text-[var(--foreground)]"
                        >
                          {linkedBugs.length > 0
                            ? linkedBugs.map((b) => b.bugKey).join(", ")
                            : exec.defectKey || <span className="opacity-35">—</span>}
                        </button>
                      )}
                      {!isCompleted && (
                        <button
                          type="button"
                          onClick={() => onLogBug(exec)}
                          title="Log or link bug"
                          className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-[var(--border)] px-1.5 text-[11px] text-[var(--muted)] hover:border-[var(--error-foreground,#B91C1C)] hover:text-[var(--error-foreground,#B91C1C)]"
                        >
                          <IconBug size={12} />
                        </button>
                      )}
                    </div>
                  </td>

                  {/* Evidence */}
                  <td className="border-r border-[var(--border)] px-2 py-1">
                    <div className="flex items-center justify-between gap-1.5">
                      <button
                        type="button"
                        onClick={() => onOpenDetail(exec)}
                        className="inline-flex items-center gap-1 text-[11.5px] text-[var(--muted)] hover:text-[var(--foreground)]"
                        title="View evidence"
                      >
                        <IconPhoto size={13} />
                        <span>{evidenceCount}</span>
                      </button>
                      {!isCompleted && (
                        <button
                          type="button"
                          disabled={uploadingExecId === exec.id}
                          onClick={() => {
                            uploadTargetExecIdRef.current = exec.id;
                            fileInputRef.current?.click();
                          }}
                          title="Upload evidence (or select row & Ctrl+V screenshot)"
                          className="inline-flex h-6 items-center gap-1 rounded border border-[var(--border)] px-1.5 text-[11px] text-[var(--muted)] hover:border-[var(--brand-primary)] hover:text-[var(--accent-light)] disabled:opacity-50"
                        >
                          {uploadingExecId === exec.id ? (
                            <IconLoader2 size={11} className="animate-spin" />
                          ) : (
                            <IconPaperclip size={11} />
                          )}
                          Add
                        </button>
                      )}
                    </div>
                  </td>

                  {/* Open detail */}
                  <td className="px-2 py-1 text-center">
                    <button
                      type="button"
                      onClick={() => onOpenDetail(exec)}
                      title="Open execution detail"
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--brand-soft)] hover:text-[var(--accent-light)]"
                    >
                      <IconExternalLink size={14} stroke={1.8} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
