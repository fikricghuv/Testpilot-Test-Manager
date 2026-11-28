"use client";

import { useState, type ComponentType } from "react";
import { IconClipboardCheck, IconCopy } from "@tabler/icons-react";
import { cx } from "@/components/ui/cx";

type IconComponent = ComponentType<{ size?: number; stroke?: number }>;

export type CopyButtonProps = {
  value: string;
  label?: string;
  copiedLabel?: string;
  iconOnly?: boolean;
  size?: "sm" | "md";
  variant?: "subtle" | "secondary";
  className?: string;
  /** Resting-state icon, e.g. a share glyph instead of the default copy icon. */
  icon?: IconComponent;
};

export default function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  iconOnly = false,
  size = "sm",
  variant = "secondary",
  className,
  icon: Icon = IconCopy,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const iconSize = size === "sm" ? 13 : 15;

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={iconOnly ? (copied ? copiedLabel : label) : undefined}
      className={cx(
        "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-[background-color,border-color,color,transform] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--denim)_30%,transparent)] focus-visible:ring-offset-1 active:scale-[0.98]",
        variant === "secondary"
          ? "border-[var(--border-strong)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
          : "border-[var(--border)] bg-transparent text-[var(--foreground)]/80 hover:border-[var(--border-strong)] hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]",
        size === "sm" ? "h-7 px-2.5 text-[11px]" : "h-8 px-3 text-xs",
        iconOnly && "px-1.5",
        className,
      )}
    >
      {copied ? <IconClipboardCheck size={iconSize} stroke={1.9} /> : <Icon size={iconSize} stroke={1.9} />}
      {!iconOnly && (copied ? copiedLabel : label)}
    </button>
  );
}
