"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconCheck,
  IconClipboardText,
  IconExternalLink,
  IconLoader2,
  IconMessageCircle,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import {
  BULK_CREATE_BATCH_SIZE,
  bulkCreateTestCases,
  createTestCase,
  createTestCaseComment,
  deleteTestCaseComment,
  listTestCaseComments,
  updateTestCase,
  updateTestCaseComment,
  type SuiteNode,
  type TestCaseComment,
  type TestCaseListItem,
} from "@/lib/api";
import { parseSpreadsheetPaste, type ParsedSpreadsheetRow } from "@/lib/spreadsheet-paste";

const GRID_PRIORITIES = ["P0", "P1", "P2", "P3", "Not set"];
const GRID_STATUSES = ["Draft", "In Review", "Approved", "Deprecated", "Archived"];
const GRID_TYPES = [
  "Functional",
  "Regression",
  "Smoke",
  "Sanity",
  "Integration",
  "API",
  "UI",
  "Performance",
  "Security",
  "Acceptance",
  "Usability",
  "Compatibility",
  "Exploratory",
  "Other",
];
const GRID_AUTOMATION = ["Automated", "Not Automated", "To Be Automated", "Can't Automate"];
const ID_PREFIX_OPTIONS = ["Auto", "SMOKE", "IT", "UAT", "REG", "DT"] as const;

type EditableTextField = "externalId" | "component" | "title";
const EDITABLE_TEXT_FIELDS: EditableTextField[] = ["externalId", "component", "title"];

export type RepositoryTestCaseGridProps = {
  projectId: string;
  cases: TestCaseListItem[];
  suites: SuiteNode[];
  activeSuiteId: string | null;
  selectedCaseIdSet: Set<string>;
  areAllCasesSelected: boolean;
  onToggleSelectAll: () => void;
  onToggleCase: (id: string) => void;
  onSelectRange: (ids: string[]) => void;
  onOpenRow: (id: string) => void;
  onPatchCaseLocal: (id: string, patch: Partial<TestCaseListItem>) => void;
  onCasesChanged: () => Promise<void> | void;
};

function buildAutoExternalId(prefix: string, moduleName: string, cases: TestCaseListItem[]): string {
  const cleanMod = moduleName
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 16) || "GEN";
  const head = `${prefix}-${cleanMod}-`;
  let maxNum = 0;
  for (const tc of cases) {
    if (tc.externalId.toUpperCase().startsWith(head)) {
      const suffix = tc.externalId.slice(head.length);
      const n = Number.parseInt(suffix, 10);
      if (Number.isFinite(n) && n > maxNum) maxNum = n;
    }
  }
  return `${head}${String(maxNum + 1).padStart(3, "0")}`;
}

export function RepositoryTestCaseGrid({
  projectId,
  cases,
  suites,
  activeSuiteId,
  selectedCaseIdSet,
  areAllCasesSelected,
  onToggleSelectAll,
  onToggleCase,
  onSelectRange,
  onOpenRow,
  onPatchCaseLocal,
  onCasesChanged,
}: RepositoryTestCaseGridProps) {
  const [editingCell, setEditingCell] = useState<{ rowId: string; field: EditableTextField } | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Quick-add row state
  const [newPrefix, setNewPrefix] = useState<(typeof ID_PREFIX_OPTIONS)[number]>("Auto");
  const [newModule, setNewModule] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState("Functional");
  const [newPriority, setNewPriority] = useState("P2");
  const [creatingRow, setCreatingRow] = useState(false);

  // Paste from Google Sheet / Excel state
  const [pasteRows, setPasteRows] = useState<ParsedSpreadsheetRow[] | null>(null);
  const [pasteSuiteIdOverride, setPasteSuiteIdOverride] = useState<string | null>(null);
  const pasteSuiteId = pasteSuiteIdOverride ?? activeSuiteId ?? "";
  const [pasteManualOpen, setPasteManualOpen] = useState(false);
  const [pasteManualText, setPasteManualText] = useState("");
  const [importingPaste, setImportingPaste] = useState(false);

  // Review comment drawer/modal state
  const [reviewTc, setReviewTc] = useState<TestCaseListItem | null>(null);
  const [reviewComments, setReviewComments] = useState<TestCaseComment[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewDraft, setReviewDraft] = useState("");
  const [reviewField, setReviewField] = useState("General");
  const [reviewSubmitting, setReviewSubmitting] = useState(false);

  const lastCheckedIdxRef = useRef<number | null>(null);
  const quickTitleRef = useRef<HTMLInputElement>(null);
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

  const persistField = useCallback(
    async (tc: TestCaseListItem, patch: Partial<TestCaseListItem> & Record<string, unknown>) => {
      setSaveState("saving");
      setSaveError(null);
      onPatchCaseLocal(tc.id, patch);
      try {
        await updateTestCase(projectId, tc.id, patch);
        markSaved();
      } catch (err) {
        setSaveState("error");
        setSaveError(err instanceof Error ? err.message : "Failed to save cell");
        await onCasesChanged();
      }
    },
    [markSaved, onCasesChanged, onPatchCaseLocal, projectId]
  );

  const startEditing = useCallback((tc: TestCaseListItem, field: EditableTextField) => {
    const val =
      field === "externalId"
        ? tc.externalId
        : field === "component"
          ? tc.component ?? ""
          : tc.title;
    setEditingCell({ rowId: tc.id, field });
    setEditDraft(val);
  }, []);

  const commitEditing = useCallback(
    async (move?: "down" | "next" | "prev") => {
      if (!editingCell) return;
      const idx = cases.findIndex((c) => c.id === editingCell.rowId);
      const tc = idx >= 0 ? cases[idx] : null;
      const field = editingCell.field;
      const trimmed = editDraft.trim();
      setEditingCell(null);

      if (tc) {
        const currentVal =
          field === "externalId"
            ? tc.externalId
            : field === "component"
              ? tc.component ?? ""
              : tc.title;

        if (trimmed !== currentVal && (field !== "title" || trimmed.length > 0)) {
          await persistField(tc, { [field]: trimmed || null });
        }
      }

      if (idx >= 0 && move) {
        if (move === "down" && idx + 1 < cases.length) {
          startEditing(cases[idx + 1], field);
        } else if (move === "next") {
          const fIdx = EDITABLE_TEXT_FIELDS.indexOf(field);
          if (fIdx + 1 < EDITABLE_TEXT_FIELDS.length) {
            startEditing(cases[idx], EDITABLE_TEXT_FIELDS[fIdx + 1]);
          } else if (idx + 1 < cases.length) {
            startEditing(cases[idx + 1], EDITABLE_TEXT_FIELDS[0]);
          }
        } else if (move === "prev") {
          const fIdx = EDITABLE_TEXT_FIELDS.indexOf(field);
          if (fIdx > 0) {
            startEditing(cases[idx], EDITABLE_TEXT_FIELDS[fIdx - 1]);
          } else if (idx > 0) {
            startEditing(cases[idx - 1], EDITABLE_TEXT_FIELDS[EDITABLE_TEXT_FIELDS.length - 1]);
          }
        }
      }
    },
    [cases, editDraft, editingCell, persistField, startEditing]
  );

  const handleCheckboxClick = useCallback(
    (idx: number, id: string, shiftKey: boolean) => {
      if (shiftKey && lastCheckedIdxRef.current !== null && lastCheckedIdxRef.current !== idx) {
        const start = Math.min(lastCheckedIdxRef.current, idx);
        const end = Math.max(lastCheckedIdxRef.current, idx);
        const rangeIds = cases.slice(start, end + 1).map((c) => c.id);
        onSelectRange(rangeIds);
      } else {
        onToggleCase(id);
      }
      lastCheckedIdxRef.current = idx;
    },
    [cases, onSelectRange, onToggleCase]
  );

  const handleQuickCreate = useCallback(async () => {
    const title = newTitle.trim();
    if (!title || creatingRow) return;
    setCreatingRow(true);
    setSaveError(null);
    try {
      const externalId =
        newPrefix !== "Auto" ? buildAutoExternalId(newPrefix, newModule, cases) : undefined;
      await createTestCase(projectId, {
        suiteId: activeSuiteId ?? undefined,
        externalId,
        component: newModule.trim() || undefined,
        title,
        type: newType,
        priority: newPriority,
        status: "Draft",
        automationStatus: "Not Automated",
        steps: JSON.stringify([]),
      });
      setNewTitle("");
      markSaved();
      await onCasesChanged();
      quickTitleRef.current?.focus();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to create test case");
    } finally {
      setCreatingRow(false);
    }
  }, [activeSuiteId, cases, creatingRow, markSaved, newModule, newPrefix, newPriority, newTitle, newType, onCasesChanged, projectId]);

  const handleGridPaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text.includes("\t") && !text.includes("\n")) return;
    const parsed = parseSpreadsheetPaste(text);
    if (parsed.length > 0) {
      e.preventDefault();
      setPasteRows(parsed);
    setPasteSuiteIdOverride(null);
    }
  }, []);

  const handleManualPasteParse = useCallback(() => {
    const parsed = parseSpreadsheetPaste(pasteManualText);
    if (parsed.length === 0) {
      setSaveError("No valid rows detected. Copy rows from Google Sheets or Excel and paste again.");
      return;
    }
    setPasteManualOpen(false);
    setPasteManualText("");
    setPasteRows(parsed);
    setPasteSuiteIdOverride(null);
  }, [pasteManualText]);

  const handleConfirmPasteImport = useCallback(async () => {
    if (!pasteRows || pasteRows.length === 0 || importingPaste) return;
    setImportingPaste(true);
    setSaveError(null);
    try {
      const payloadRows = pasteRows.map((r) => ({
        suiteId: pasteSuiteId || undefined,
        externalId: r.externalId,
        component: r.component,
        title: r.title,
        preconditions: r.preconditions,
        testData: r.testData,
        steps: JSON.stringify(r.steps),
        type: r.type,
        priority: "P2",
        status: "Draft",
        automationStatus: "Not Automated",
      }));

      for (let i = 0; i < payloadRows.length; i += BULK_CREATE_BATCH_SIZE) {
        const batch = payloadRows.slice(i, i + BULK_CREATE_BATCH_SIZE);
        await bulkCreateTestCases(projectId, { testcases: batch });
      }
      setPasteRows(null);
      markSaved();
      await onCasesChanged();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to import pasted rows");
    } finally {
      setImportingPaste(false);
    }
  }, [importingPaste, markSaved, onCasesChanged, pasteRows, pasteSuiteId, projectId]);

  const openReviewModal = useCallback(
    async (tc: TestCaseListItem) => {
      setReviewTc(tc);
      setReviewComments([]);
      setReviewDraft("");
      setReviewField("General");
      setReviewLoading(true);
      try {
        const res = await listTestCaseComments(projectId, tc.id);
        setReviewComments(res.list ?? []);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Failed to load review comments");
      } finally {
        setReviewLoading(false);
      }
    },
    [projectId]
  );

  const handleSubmitReviewComment = useCallback(
    async (markStatus?: "In Review" | "Approved") => {
      if (!reviewTc || !reviewDraft.trim() || reviewSubmitting) return;
      setReviewSubmitting(true);
      try {
        const created = await createTestCaseComment(projectId, reviewTc.id, {
          body: reviewDraft.trim(),
          targetField: reviewField,
          markStatus,
        });
        const nextComments = [...reviewComments, created];
        setReviewComments(nextComments);
        setReviewDraft("");
        const nextUnresolved = nextComments.filter((c) => !c.resolved).length;
        const patch: Partial<TestCaseListItem> = {
          unresolvedCommentCount: nextUnresolved,
          totalCommentCount: nextComments.length,
          ...(markStatus ? { status: markStatus } : {}),
        };
        onPatchCaseLocal(reviewTc.id, patch);
        setReviewTc((cur) => (cur ? { ...cur, ...patch } : cur));
        if (markStatus) {
          void onCasesChanged();
        }
        markSaved();
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Failed to add review comment");
      } finally {
        setReviewSubmitting(false);
      }
    },
    [markSaved, onCasesChanged, onPatchCaseLocal, projectId, reviewComments, reviewDraft, reviewField, reviewSubmitting, reviewTc]
  );

  const handleToggleResolveComment = useCallback(
    async (comment: TestCaseComment) => {
      if (!reviewTc) return;
      try {
        const updated = await updateTestCaseComment(projectId, reviewTc.id, comment.id, {
          resolved: !comment.resolved,
        });
        const nextComments = reviewComments.map((c) =>
          c.id === comment.id ? { ...c, resolved: updated.resolved } : c
        );
        setReviewComments(nextComments);
        onPatchCaseLocal(reviewTc.id, {
          unresolvedCommentCount: nextComments.filter((c) => !c.resolved).length,
          totalCommentCount: nextComments.length,
        });
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Failed to update comment");
      }
    },
    [onPatchCaseLocal, projectId, reviewComments, reviewTc]
  );

  const handleDeleteComment = useCallback(
    async (commentId: string) => {
      if (!reviewTc) return;
      try {
        await deleteTestCaseComment(projectId, reviewTc.id, commentId);
        const nextComments = reviewComments.filter((c) => c.id !== commentId);
        setReviewComments(nextComments);
        onPatchCaseLocal(reviewTc.id, {
          unresolvedCommentCount: nextComments.filter((c) => !c.resolved).length,
          totalCommentCount: nextComments.length,
        });
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Failed to delete comment");
      }
    },
    [onPatchCaseLocal, projectId, reviewComments, reviewTc]
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col outline-none"
      tabIndex={0}
      onPaste={handleGridPaste}
    >
      {/* Grid helper bar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface-secondary)] px-4 py-1.5 text-[11.5px] text-[var(--muted)]">
        <div className="flex flex-wrap items-center gap-3">
          <span>
            Click cell to edit &middot; <kbd className="rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5 text-[10px]">Tab</kbd> next &middot;{" "}
            <kbd className="rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5 text-[10px]">Enter</kbd> down &middot;{" "}
            <kbd className="rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5 text-[10px]">Shift+Click</kbd> range select
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
        <button
          type="button"
          onClick={() => setPasteManualOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-[5px] border border-[var(--border)] bg-[var(--background)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--foreground)] hover:border-[var(--brand-primary)] hover:text-[var(--accent-light)]"
        >
          <IconClipboardText size={13} stroke={1.8} />
          Paste from Google Sheet / Excel
        </button>
      </div>

      {/* Spreadsheet Grid */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[1080px] border-collapse text-left text-[12.5px]">
          <thead className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface-secondary)] text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-soft)]">
            <tr>
              <th className="w-9 border-r border-[var(--border)] px-2.5 py-2 text-center">
                <input
                  type="checkbox"
                  checked={areAllCasesSelected}
                  onChange={onToggleSelectAll}
                  aria-label="Select all"
                  className="h-3.5 w-3.5 rounded border-[var(--border-strong)] accent-[var(--brand-primary)]"
                />
              </th>
              <th className="w-10 border-r border-[var(--border)] px-2 py-2 text-center">#</th>
              <th className="w-[180px] border-r border-[var(--border)] px-2.5 py-2">Test Case ID</th>
              <th className="w-[140px] border-r border-[var(--border)] px-2.5 py-2">Module</th>
              <th className="min-w-[260px] border-r border-[var(--border)] px-2.5 py-2">Scenario / Test Case</th>
              <th className="w-[140px] border-r border-[var(--border)] px-2.5 py-2">Suite</th>
              <th className="w-[120px] border-r border-[var(--border)] px-2.5 py-2">Type</th>
              <th className="w-[90px] border-r border-[var(--border)] px-2.5 py-2">Priority</th>
              <th className="w-[110px] border-r border-[var(--border)] px-2.5 py-2">Status</th>
              <th className="w-[130px] border-r border-[var(--border)] px-2.5 py-2">Automation</th>
              <th className="w-16 border-r border-[var(--border)] px-2 py-2 text-center">Review</th>
              <th className="w-14 px-2 py-2 text-center">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {cases.map((tc, idx) => {
              const isSelected = selectedCaseIdSet.has(tc.id);
              const isEditingId = editingCell?.rowId === tc.id && editingCell.field === "externalId";
              const isEditingComp = editingCell?.rowId === tc.id && editingCell.field === "component";
              const isEditingTitle = editingCell?.rowId === tc.id && editingCell.field === "title";

              return (
                <tr
                  key={tc.id}
                  className={`group transition-colors ${
                    isSelected ? "bg-[var(--brand-soft)]" : "hover:bg-[var(--surface-secondary)]/60"
                  }`}
                >
                  <td className="border-r border-[var(--border)] px-2.5 py-1.5 text-center">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {}}
                      onClick={(e) => handleCheckboxClick(idx, tc.id, e.shiftKey)}
                      aria-label={`Select ${tc.externalId}`}
                      className="h-3.5 w-3.5 cursor-pointer rounded border-[var(--border-strong)] accent-[var(--brand-primary)]"
                    />
                  </td>
                  <td className="border-r border-[var(--border)] px-2 py-1.5 text-center text-[11px] text-[var(--muted-soft)]">
                    {idx + 1}
                  </td>

                  {/* externalId */}
                  <td
                    onClick={() => !isEditingId && startEditing(tc, "externalId")}
                    className="cursor-text border-r border-[var(--border)] px-2 py-1 font-mono text-[11.5px] text-[var(--foreground)]"
                  >
                    {isEditingId ? (
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
                        className="w-full rounded border border-[var(--brand-primary)] bg-[var(--background)] px-1.5 py-0.5 font-mono text-[11.5px] outline-none"
                      />
                    ) : (
                      <span className="block truncate">{tc.externalId}</span>
                    )}
                  </td>

                  {/* component / module */}
                  <td
                    onClick={() => !isEditingComp && startEditing(tc, "component")}
                    className="cursor-text border-r border-[var(--border)] px-2 py-1 text-[var(--foreground)]"
                  >
                    {isEditingComp ? (
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
                        className="w-full rounded border border-[var(--brand-primary)] bg-[var(--background)] px-1.5 py-0.5 text-[12px] outline-none"
                      />
                    ) : (
                      <span className="block truncate text-[12px] text-[var(--muted)]">
                        {tc.component || <span className="opacity-30">—</span>}
                      </span>
                    )}
                  </td>

                  {/* title */}
                  <td
                    onClick={() => !isEditingTitle && startEditing(tc, "title")}
                    className="cursor-text border-r border-[var(--border)] px-2 py-1 font-medium text-[var(--foreground)]"
                  >
                    {isEditingTitle ? (
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
                        className="w-full rounded border border-[var(--brand-primary)] bg-[var(--background)] px-1.5 py-0.5 text-[12.5px] font-medium outline-none"
                      />
                    ) : (
                      <span className="block truncate">{tc.title}</span>
                    )}
                  </td>

                  {/* Suite */}
                  <td className="border-r border-[var(--border)] px-1.5 py-1">
                    <select
                      value={tc.suiteId ?? ""}
                      onChange={(e) =>
                        void persistField(tc, { suiteId: e.target.value || null })
                      }
                      className="w-full cursor-pointer rounded bg-transparent px-1 py-0.5 text-[12px] text-[var(--foreground)] outline-none focus:bg-[var(--background)] focus:ring-1 focus:ring-[var(--brand-primary)]"
                    >
                      <option value="">Unassigned</option>
                      {suites.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </td>

                  {/* Type */}
                  <td className="border-r border-[var(--border)] px-1.5 py-1">
                    <select
                      value={tc.type}
                      onChange={(e) => void persistField(tc, { type: e.target.value })}
                      className="w-full cursor-pointer rounded bg-transparent px-1 py-0.5 text-[12px] text-[var(--foreground)] outline-none focus:bg-[var(--background)] focus:ring-1 focus:ring-[var(--brand-primary)]"
                    >
                      {GRID_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>

                  {/* Priority */}
                  <td className="border-r border-[var(--border)] px-1.5 py-1">
                    <select
                      value={tc.priority}
                      onChange={(e) => void persistField(tc, { priority: e.target.value })}
                      className="w-full cursor-pointer rounded bg-transparent px-1 py-0.5 text-[12px] font-medium text-[var(--foreground)] outline-none focus:bg-[var(--background)] focus:ring-1 focus:ring-[var(--brand-primary)]"
                    >
                      {GRID_PRIORITIES.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </td>

                  {/* Status */}
                  <td className="border-r border-[var(--border)] px-1.5 py-1">
                    <select
                      value={tc.status}
                      onChange={(e) => void persistField(tc, { status: e.target.value })}
                      className="w-full cursor-pointer rounded bg-transparent px-1 py-0.5 text-[12px] text-[var(--foreground)] outline-none focus:bg-[var(--background)] focus:ring-1 focus:ring-[var(--brand-primary)]"
                    >
                      {GRID_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </td>

                  {/* Automation */}
                  <td className="border-r border-[var(--border)] px-1.5 py-1">
                    <select
                      value={tc.automationStatus}
                      onChange={(e) =>
                        void persistField(tc, { automationStatus: e.target.value })
                      }
                      className="w-full cursor-pointer rounded bg-transparent px-1 py-0.5 text-[12px] text-[var(--foreground)] outline-none focus:bg-[var(--background)] focus:ring-1 focus:ring-[var(--brand-primary)]"
                    >
                      {GRID_AUTOMATION.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  </td>

                  {/* Review Comment */}
                  <td className="border-r border-[var(--border)] px-2 py-1 text-center">
                    <button
                      type="button"
                      onClick={() => void openReviewModal(tc)}
                      title={
                        (tc.unresolvedCommentCount ?? 0) > 0
                          ? `${tc.unresolvedCommentCount} unresolved review comment(s)`
                          : (tc.totalCommentCount ?? 0) > 0
                            ? "All review comments resolved"
                            : "Add review comment"
                      }
                      className={`inline-flex h-6 items-center justify-center gap-1 rounded px-1.5 text-[11px] font-medium transition-colors ${
                        (tc.unresolvedCommentCount ?? 0) > 0
                          ? "bg-[var(--warning-soft,#FEF3C7)] text-[var(--warning-foreground,#B45309)] hover:opacity-90"
                          : (tc.totalCommentCount ?? 0) > 0
                            ? "bg-[var(--success-soft,#DCFCE7)] text-[var(--success-foreground,#15803D)] hover:opacity-90"
                            : "text-[var(--muted)] hover:bg-[var(--brand-soft)] hover:text-[var(--accent-light)]"
                      }`}
                    >
                      <IconMessageCircle size={13} stroke={1.8} />
                      {(tc.unresolvedCommentCount ?? 0) > 0 ? (
                        <span>{tc.unresolvedCommentCount}</span>
                      ) : (tc.totalCommentCount ?? 0) > 0 ? (
                        <IconCheck size={11} stroke={2.5} />
                      ) : null}
                    </button>
                  </td>

                  {/* Open detail */}
                  <td className="px-2 py-1 text-center">
                    <button
                      type="button"
                      onClick={() => onOpenRow(tc.id)}
                      title="Open full test case details (Steps, Preconditions, Evidence)"
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--brand-soft)] hover:text-[var(--accent-light)]"
                    >
                      <IconExternalLink size={14} stroke={1.8} />
                    </button>
                  </td>
                </tr>
              );
            })}

            {/* Quick Add Row */}
            <tr className="bg-[var(--surface-secondary)]/40">
              <td className="border-r border-[var(--border)] px-2 py-1.5 text-center text-[var(--brand-primary)]">
                <IconPlus size={14} stroke={2} className="mx-auto" />
              </td>
              <td className="border-r border-[var(--border)] px-2 py-1.5 text-center text-[11px] text-[var(--muted-soft)]">
                New
              </td>
              <td className="border-r border-[var(--border)] px-1.5 py-1">
                <select
                  value={newPrefix}
                  onChange={(e) =>
                    setNewPrefix(e.target.value as (typeof ID_PREFIX_OPTIONS)[number])
                  }
                  title="Test Case ID prefix"
                  className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-1.5 py-1 font-mono text-[11.5px] text-[var(--foreground)] outline-none focus:border-[var(--brand-primary)]"
                >
                  {ID_PREFIX_OPTIONS.map((p) => (
                    <option key={p} value={p}>
                      {p === "Auto" ? "ID: Auto" : `${p}-...`}
                    </option>
                  ))}
                </select>
              </td>
              <td className="border-r border-[var(--border)] px-1.5 py-1">
                <input
                  value={newModule}
                  onChange={(e) => setNewModule(e.target.value)}
                  placeholder="Module (e.g. Login)"
                  className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--brand-primary)]"
                />
              </td>
              <td className="border-r border-[var(--border)] px-1.5 py-1">
                <input
                  ref={quickTitleRef}
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleQuickCreate();
                    }
                  }}
                  placeholder="+ Ketik judul skenario lalu tekan Enter..."
                  className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-[12.5px] text-[var(--foreground)] outline-none focus:border-[var(--brand-primary)]"
                />
              </td>
              <td className="border-r border-[var(--border)] px-2 py-1 text-[11.5px] text-[var(--muted)]">
                {activeSuiteId ? "Current suite" : "Unassigned"}
              </td>
              <td className="border-r border-[var(--border)] px-1.5 py-1">
                <select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value)}
                  className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-1 py-1 text-[12px] outline-none"
                >
                  {GRID_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </td>
              <td className="border-r border-[var(--border)] px-1.5 py-1">
                <select
                  value={newPriority}
                  onChange={(e) => setNewPriority(e.target.value)}
                  className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-1 py-1 text-[12px] outline-none"
                >
                  {GRID_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </td>
              <td colSpan={4} className="px-2 py-1">
                <button
                  type="button"
                  disabled={!newTitle.trim() || creatingRow}
                  onClick={() => void handleQuickCreate()}
                  className="inline-flex h-7 items-center gap-1 rounded-[5px] bg-[var(--cta-primary)] px-2.5 text-[11.5px] font-medium text-white hover:bg-[var(--cta-hover)] disabled:opacity-40"
                >
                  {creatingRow ? (
                    <IconLoader2 size={12} stroke={2} className="animate-spin" />
                  ) : (
                    <IconPlus size={12} stroke={2.2} />
                  )}
                  Add row
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Manual Paste Modal */}
      {pasteManualOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-[var(--border)] bg-[var(--background)] p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-semibold text-[var(--foreground)]">
                Paste from Google Sheets / Excel
              </h3>
              <button
                type="button"
                onClick={() => setPasteManualOpen(false)}
                className="text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                <IconX size={18} />
              </button>
            </div>
            <p className="mt-1 text-[12px] text-[var(--muted)]">
              Copy baris dari Google Sheet atau Excel (format kolom standar QA: No, Module, Scenario, Test Case ID, Pre-Condition, Test Data, Test Steps, Test Type, Expected Result) lalu paste di bawah.
            </p>
            <textarea
              autoFocus
              rows={8}
              value={pasteManualText}
              onChange={(e) => setPasteManualText(e.target.value)}
              placeholder="Paste rows here (Ctrl+V / Cmd+V)..."
              className="mt-3 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 font-mono text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--brand-primary)]"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPasteManualOpen(false)}
                className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12.5px] text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleManualPasteParse}
                disabled={!pasteManualText.trim()}
                className="rounded-md bg-[var(--cta-primary)] px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:bg-[var(--cta-hover)] disabled:opacity-50"
              >
                Preview rows
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Paste Preview & Confirm Modal */}
      {pasteRows && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[85vh] w-full max-w-4xl flex-col rounded-xl border border-[var(--border)] bg-[var(--background)] p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-[15px] font-semibold text-[var(--foreground)]">
                  Import {pasteRows.length} pasted test case{pasteRows.length > 1 ? "s" : ""}
                </h3>
                <p className="mt-0.5 text-[12px] text-[var(--muted)]">
                  Periksa hasil parsing kolom &amp; steps sebelum disimpan ke Testpilot.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPasteRows(null)}
                className="text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                <IconX size={18} />
              </button>
            </div>

            <div className="mt-3 flex items-center gap-2 text-[12.5px]">
              <span className="font-medium text-[var(--muted)]">Target Suite:</span>
              <select
                value={pasteSuiteId}
                onChange={(e) => setPasteSuiteIdOverride(e.target.value)}
                className="rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-1 text-[12.5px] text-[var(--foreground)] outline-none"
              >
                <option value="">Unassigned (No Suite)</option>
                {suites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-3 min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--border)]">
              <table className="w-full border-collapse text-left text-[12px]">
                <thead className="sticky top-0 border-b border-[var(--border)] bg-[var(--surface-secondary)] text-[11px] font-semibold uppercase text-[var(--muted-soft)]">
                  <tr>
                    <th className="px-2.5 py-2">ID</th>
                    <th className="px-2.5 py-2">Module</th>
                    <th className="px-2.5 py-2">Scenario / Title</th>
                    <th className="px-2.5 py-2">Type</th>
                    <th className="px-2.5 py-2">Steps</th>
                    <th className="px-2.5 py-2">Expected Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {pasteRows.map((row, idx) => (
                    <tr key={idx}>
                      <td className="px-2.5 py-2 font-mono text-[11px]">
                        {row.externalId ? (
                          <span className="inline-flex items-center gap-1">
                            {row.detectedPrefix && (
                              <span className="rounded bg-[var(--brand-soft)] px-1 py-0.5 text-[10px] font-semibold text-[var(--accent-light)]">
                                {row.detectedPrefix}
                              </span>
                            )}
                            {row.externalId}
                          </span>
                        ) : (
                          <span className="text-[var(--muted-soft)]">Auto</span>
                        )}
                      </td>
                      <td className="px-2.5 py-2 text-[var(--muted)]">{row.component || "—"}</td>
                      <td className="px-2.5 py-2 font-medium text-[var(--foreground)]">{row.title}</td>
                      <td className="px-2.5 py-2">{row.type}</td>
                      <td className="px-2.5 py-2 text-[var(--muted)]">{row.steps.length} step(s)</td>
                      <td className="max-w-[240px] truncate px-2.5 py-2 text-[var(--muted)]">
                        {row.expectedResult || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPasteRows(null)}
                className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12.5px] text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={importingPaste}
                onClick={() => void handleConfirmPasteImport()}
                className="inline-flex items-center gap-1.5 rounded-md bg-[var(--cta-primary)] px-4 py-1.5 text-[12.5px] font-medium text-white hover:bg-[var(--cta-hover)] disabled:opacity-50"
              >
                {importingPaste && <IconLoader2 size={13} stroke={2} className="animate-spin" />}
                Import {pasteRows.length} test case{pasteRows.length > 1 ? "s" : ""}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Review Comments Modal */}
      {reviewTc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl border border-[var(--border)] bg-[var(--background)] p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11.5px] text-[var(--muted)]">{reviewTc.externalId}</span>
                  <span className="rounded-full bg-[var(--surface-secondary)] px-2 py-0.5 text-[11px] font-medium text-[var(--foreground)]">
                    {reviewTc.status}
                  </span>
                </div>
                <h3 className="mt-1 truncate text-[15px] font-semibold text-[var(--foreground)]">
                  Review Notes: {reviewTc.title}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setReviewTc(null)}
                className="text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                <IconX size={18} />
              </button>
            </div>

            <div className="mt-3 min-h-[120px] flex-1 space-y-2.5 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)]/40 p-3">
              {reviewLoading ? (
                <div className="flex items-center justify-center py-8 text-[12px] text-[var(--muted)]">
                  <IconLoader2 size={14} className="mr-1.5 animate-spin" />
                  Loading comments…
                </div>
              ) : reviewComments.length === 0 ? (
                <p className="py-8 text-center text-[12px] text-[var(--muted-soft)]">
                  Belum ada catatan review. Tambahkan komentar untuk kolom/bagian tertentu di bawah.
                </p>
              ) : (
                reviewComments.map((c) => (
                  <div
                    key={c.id}
                    className={`rounded-lg border border-[var(--border)] bg-[var(--background)] p-2.5 text-[12px] ${
                      c.resolved ? "opacity-60" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[var(--foreground)]">{c.authorName}</span>
                        <span className="rounded bg-[var(--brand-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent-light)]">
                          {c.targetField}
                        </span>
                        {c.resolved && (
                          <span className="rounded bg-[var(--success-soft,#DCFCE7)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--success-foreground,#15803D)]">
                            Resolved
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void handleToggleResolveComment(c)}
                          className="text-[11px] font-medium text-[var(--brand-primary)] hover:underline"
                        >
                          {c.resolved ? "Reopen" : "Resolve"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteComment(c.id)}
                          title="Delete comment"
                          className="text-[var(--muted)] hover:text-[var(--error-foreground)]"
                        >
                          <IconTrash size={12} />
                        </button>
                      </div>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-[var(--foreground)]">{c.body}</p>
                  </div>
                ))
              )}
            </div>

            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2 text-[12px]">
                <span className="text-[var(--muted)]">Target cell / field:</span>
                <select
                  value={reviewField}
                  onChange={(e) => setReviewField(e.target.value)}
                  className="rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-[12px] text-[var(--foreground)] outline-none"
                >
                  <option value="General">General</option>
                  <option value="Test Case ID">Test Case ID</option>
                  <option value="Module">Module</option>
                  <option value="Title">Scenario / Title</option>
                  <option value="Pre-Condition">Pre-Condition</option>
                  <option value="Test Data">Test Data</option>
                  <option value="Test Steps">Test Steps</option>
                  <option value="Expected Result">Expected Result</option>
                </select>
              </div>
              <textarea
                rows={3}
                value={reviewDraft}
                onChange={(e) => setReviewDraft(e.target.value)}
                placeholder="Tulis catatan review (misal: Tolong tambahin negative case untuk password salah)..."
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-2.5 text-[12.5px] text-[var(--foreground)] outline-none focus:border-[var(--brand-primary)]"
              />
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={!reviewDraft.trim() || reviewSubmitting}
                  onClick={() => void handleSubmitReviewComment("In Review")}
                  className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12px] font-medium text-[var(--foreground)] hover:border-[var(--warning-foreground,#B45309)] disabled:opacity-40"
                >
                  Comment &amp; Set In Review
                </button>
                <button
                  type="button"
                  disabled={!reviewDraft.trim() || reviewSubmitting}
                  onClick={() => void handleSubmitReviewComment("Approved")}
                  className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12px] font-medium text-[var(--success-foreground,#15803D)] hover:border-[var(--success-foreground,#15803D)] disabled:opacity-40"
                >
                  Comment &amp; Approve
                </button>
                <button
                  type="button"
                  disabled={!reviewDraft.trim() || reviewSubmitting}
                  onClick={() => void handleSubmitReviewComment()}
                  className="inline-flex items-center gap-1 rounded-md bg-[var(--cta-primary)] px-3.5 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--cta-hover)] disabled:opacity-40"
                >
                  {reviewSubmitting && <IconLoader2 size={12} className="animate-spin" />}
                  Add Note
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
