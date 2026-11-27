"use client";

import {
  IconLayoutDashboard,
  IconChartBar,
  IconTable,
  IconDatabase,
  IconActivity,
  IconBolt,
  IconTrendingUp,
  IconFileExport,
  IconTableExport,
} from "@tabler/icons-react";

export type ReportView = "overview" | "execution" | "matrix" | "repository" | "performance" | "insights" | "trends";

type NavItem = {
  id: ReportView;
  label: string;
  icon: React.ComponentType<{ size?: number; stroke?: number; className?: string }>;
};

const REPORT_ITEMS: NavItem[] = [
  { id: "overview", label: "Overview", icon: IconLayoutDashboard },
  { id: "execution", label: "Execution Report", icon: IconChartBar },
  { id: "matrix", label: "Traceability", icon: IconTable },
  { id: "repository", label: "Repository", icon: IconDatabase },
  { id: "performance", label: "Performance", icon: IconBolt },
];

function NavRow({
  active,
  icon: Icon,
  label,
  badge,
  onClick,
}: {
  active: boolean;
  icon: React.ComponentType<{ size?: number; stroke?: number; className?: string }>;
  label: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex h-8 w-full items-center gap-2.5 rounded-[6px] px-2.5 text-left text-[13px] transition-colors duration-150 ${
        active
          ? "bg-[var(--surface-secondary)] font-medium text-[var(--foreground)]"
          : "text-[var(--muted)] hover:bg-[var(--surface-secondary)]/60 hover:text-[var(--foreground)]"
      }`}
    >
      <Icon
        size={16}
        stroke={1.75}
        className={active ? "shrink-0 text-[var(--foreground)]" : "shrink-0 text-[var(--muted-soft)]"}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {typeof badge === "number" && badge > 0 && (
        <span className="shrink-0 rounded-[4px] bg-[var(--status-fail-fill)] px-1.5 py-0.5 font-mono text-[11px] leading-none tabular-nums text-[var(--status-fail-text)]">
          {badge}
        </span>
      )}
    </button>
  );
}

export function ReportsNav({
  activeView,
  onViewChange,
  flakyCount,
  csvHref,
  xlsxHref,
}: {
  activeView: ReportView;
  onViewChange: (v: ReportView) => void;
  flakyCount: number;
  /* Export hrefs for the view currently on screen — see the Export section at the foot of the nav. */
  csvHref: string;
  xlsxHref: string;
}) {
  return (
    <aside className="flex w-[212px] shrink-0 flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--surface)]">
      <nav aria-label="Reports navigation" className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2.5 py-3.5">
        <div>
          <p className="mb-1.5 px-2.5 text-[11px] font-medium text-[var(--muted-soft)]">Reports</p>
          <div className="space-y-0.5">
            {REPORT_ITEMS.map((item) => (
              <NavRow
                key={item.id}
                active={activeView === item.id}
                icon={item.icon}
                label={item.label}
                onClick={() => onViewChange(item.id)}
              />
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1.5 px-2.5 text-[11px] font-medium text-[var(--muted-soft)]">Signals</p>
          <div className="space-y-0.5">
            <NavRow
              active={activeView === "insights"}
              icon={IconActivity}
              label="AI Insights"
              badge={flakyCount}
              onClick={() => onViewChange("insights")}
            />
            <NavRow
              active={activeView === "trends"}
              icon={IconTrendingUp}
              label="Trends"
              onClick={() => onViewChange("trends")}
            />
          </div>
        </div>
      </nav>

      {/*
        * Basecamp 10218723531 — "Reports & Insights > Export buttons are not working" (plural: the
        * top bar's Export and these two). Both of these were divs with title="Coming soon" and no
        * handler; they export the view currently on screen now.
        *
        * "Export PDF" is gone rather than wired. There is no PDF pipeline anywhere in the product,
        * and a menu entry that advertises one is the defect the card reported — not something a
        * href can fix. Recorded for whoever picks the feature up, not quietly disabled.
        */}
      <div className="shrink-0 border-t border-[var(--border)] px-2.5 py-3">
        <p className="mb-1.5 px-2.5 text-[11px] font-medium text-[var(--muted-soft)]">Export</p>
        <div className="space-y-0.5">
          <a
            href={csvHref}
            target="_blank"
            rel="noreferrer"
            data-testid="reports-nav-export-csv"
            className="flex h-8 w-full items-center gap-2.5 rounded-[6px] px-2.5 text-[13px] text-[var(--muted)] transition-colors duration-150 hover:bg-[var(--surface-secondary)]/60 hover:text-[var(--foreground)]"
          >
            <IconTableExport size={16} stroke={1.75} className="shrink-0 text-[var(--muted-soft)]" />
            <span>Export CSV</span>
          </a>
          <a
            href={xlsxHref}
            target="_blank"
            rel="noreferrer"
            data-testid="reports-nav-export-xlsx"
            className="flex h-8 w-full items-center gap-2.5 rounded-[6px] px-2.5 text-[13px] text-[var(--muted)] transition-colors duration-150 hover:bg-[var(--surface-secondary)]/60 hover:text-[var(--foreground)]"
          >
            <IconFileExport size={16} stroke={1.75} className="shrink-0 text-[var(--muted-soft)]" />
            <span>Export Excel</span>
          </a>
        </div>
      </div>
    </aside>
  );
}
