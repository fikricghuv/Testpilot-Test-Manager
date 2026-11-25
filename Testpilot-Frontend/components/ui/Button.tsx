import type { ButtonHTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "destructive" | "ai" | "confidence";
type ButtonSize = "sm" | "md" | "lg" | "icon";

const variantClasses: Record<ButtonVariant, string> = {
  // TestPilot primary action: solid ink background, high contrast, snappy hover and click depression
  primary:
    "border border-transparent bg-[var(--cta-primary)] text-white dark:text-[#09090b] font-medium shadow-none hover:bg-[var(--cta-hover)] active:scale-[0.98]",
  // TestPilot secondary action: crisp hairline border, neutral surface
  secondary:
    "border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--foreground)] font-medium hover:bg-[var(--surface-secondary)] active:scale-[0.98]",
  // Borderless action
  ghost:
    "border-0 bg-transparent text-[var(--muted)] hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)] active:scale-[0.98]",
  // Destructive actions
  danger:
    "border border-[var(--error-border)] bg-[var(--error-soft)] text-[var(--status-fail-text)] font-medium hover:bg-[var(--error)] hover:text-white active:scale-[0.98]",
  destructive:
    "border border-[var(--error-border)] bg-[var(--error-soft)] text-[var(--status-fail-text)] font-medium hover:bg-[var(--error)] hover:text-white active:scale-[0.98]",
  // AI & telemetry actions: clean neutral styling with subtle border
  ai: "border border-[var(--border)] bg-[var(--surface-secondary)] text-[var(--foreground)] font-medium hover:bg-[var(--surface-tertiary)] active:scale-[0.98]",
  confidence:
    "border border-[var(--border)] bg-[var(--surface-secondary)] text-[var(--foreground)] font-medium hover:bg-[var(--surface-tertiary)] active:scale-[0.98]",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 rounded-[6px] px-3 text-[13px] font-medium",
  md: "h-9 rounded-[6px] px-4 text-[13px] font-medium",
  lg: "h-10 rounded-[6px] px-5 text-[14px] font-medium",
  // Square icon-only button. cx() is a plain className join (no tailwind-merge dedup), so this
  // carries no padding utility of its own — callers that need icon buttons use this instead of
  // fighting sizeClasses.sm's `px-3` with an ad-hoc `p-0` override, which is a cascade-order race
  // that can leave the padding in place and squeeze/clip the icon inside a fixed h-8 w-8 box.
  icon: "h-8 w-8 rounded-[6px]",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
};

export default function Button({
  className,
  variant = "primary",
  size = "md",
  fullWidth = false,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-[background-color,border-color,color,opacity,transform] duration-150 ease-[var(--ease-out-quad)]",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--denim)_30%,transparent)] focus-visible:ring-offset-1",
        "cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
        variantClasses[variant],
        sizeClasses[size],
        fullWidth && "w-full",
        className,
      )}
      {...props}
    />
  );
}
