"use client";

import Link from "next/link";
import { IconExternalLink, IconTimeline } from "@tabler/icons-react";
import { type ExecutionEvidence } from "@/lib/api";
import { formatFileSizeShort } from "@/lib/validation";

interface Props {
  cycleId: string;
  executionId: string;
  file: ExecutionEvidence;
}

export default function TraceViewerPanel({ cycleId, executionId, file }: Props) {
  const subtitle = `${file.fileName}${file.fileSize != null ? ` — ${formatFileSizeShort(file.fileSize)}` : ""}`;
  const inspectorHref = `/trace/${cycleId}/${executionId}/${file.id}`;

  return (
    <div
      data-testid="trace-viewer"
      className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-secondary)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--brand-primary)]/15 text-[var(--brand-primary)]">
            <IconTimeline size={15} />
          </div>
          <div className="min-w-0">
            <p className="text-[12.5px] font-semibold text-[var(--foreground)]">Execution Trace Inspector</p>
            <p className="truncate text-[11px] text-[var(--muted)]" title={subtitle}>
              {subtitle}
            </p>
          </div>
        </div>

        <Link
          href={inspectorHref}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="trace-open-tab"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[11.5px] font-medium text-[var(--foreground)] transition-colors hover:border-[var(--brand-primary)]"
        >
          Inspect Trace
          <IconExternalLink size={13} className="text-[var(--muted)]" />
        </Link>
      </div>
    </div>
  );
}
