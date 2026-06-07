import type { ReactNode } from "react";
import { SectionChip } from "../lib/runtimeUi";

export interface HarnessDetailRow {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "fail" | "muted";
  detail?: string;
}

export interface HarnessAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  variant?: "primary" | "default" | "warn";
}

export interface HarnessActionCardProps {
  title: string;
  description?: string;
  ariaLabel?: string;
  statusChip?: { label: string; tone: "ok" | "warn" | "fail" | "muted" };
  details?: HarnessDetailRow[];
  primaryAction?: HarnessAction;
  secondaryActions?: HarnessAction[];
  warning?: string;
  nextAction?: string;
  nextActionTone?: "ok" | "warn" | "fail";
  variant?: "default" | "advanced";
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

function dotToneClass(tone?: HarnessDetailRow["tone"]): string {
  switch (tone) {
    case "ok": return "ws-color-ok";
    case "warn": return "ws-color-warn";
    case "fail": return "ws-color-fail";
    default: return "ws-color-dim";
  }
}

function btnClass(action: HarnessAction): string {
  const base = "btn btn-sm";
  if (action.variant === "primary") return `${base} btn-primary`;
  if (action.variant === "warn") return `${base} btn-warn`;
  return base;
}

export function HarnessActionGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={`harness-action-grid ws-section-actions${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}

export function HarnessActionCard({
  title,
  description,
  ariaLabel,
  statusChip,
  details,
  primaryAction,
  secondaryActions,
  warning,
  nextAction,
  nextActionTone = "warn",
  variant = "default",
  children,
  footer,
  className,
}: HarnessActionCardProps) {
  const sectionClass = [
    "ws-section",
    "harness-action-card",
    variant === "advanced" ? "harness-action-card-advanced" : "",
    className ?? "",
  ].filter(Boolean).join(" ");

  return (
    <div className={sectionClass} role="region" aria-label={ariaLabel ?? title}>
      <div className="ws-section-header">
        <span className="ws-section-title">{title}</span>
        {statusChip && <SectionChip label={statusChip.label} tone={statusChip.tone} />}
      </div>

      {description && (
        <p className="harness-action-card-desc">{description}</p>
      )}

      {details && details.length > 0 && (
        <div className="harness-detail-rows ws-runtime-rows" aria-live="polite">
          {details.map(row => (
            <div key={row.label} className="ws-runtime-row harness-detail-row">
              <span className="ws-runtime-row-label">{row.label}</span>
              <span className={`ws-dot ${dotToneClass(row.tone)}`}>{"\u25CF"}</span>
              <span className="ws-runtime-row-value">
                {row.value}
                {row.detail && <span className="ws-runtime-row-detail"> — {row.detail}</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {warning && (
        <div className="harness-action-warning ws-runtime-next-action ws-runtime-next-action-warn" role="status">
          {warning}
        </div>
      )}

      {nextAction && (
        <div className={`harness-action-next ws-runtime-next-action ws-runtime-next-action-${nextActionTone}`} role="status">
          {nextAction}
        </div>
      )}

      {children}

      {(secondaryActions?.length || primaryAction) && (
        <HarnessActionGrid>
          {secondaryActions?.map(action => (
            <button
              key={action.label}
              type="button"
              className={btnClass(action)}
              disabled={action.disabled}
              title={action.title}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
          {primaryAction && (
            <button
              type="button"
              className={btnClass({ ...primaryAction, variant: primaryAction.variant ?? "primary" })}
              disabled={primaryAction.disabled}
              title={primaryAction.title}
              onClick={primaryAction.onClick}
            >
              {primaryAction.label}
            </button>
          )}
        </HarnessActionGrid>
      )}

      {footer}
    </div>
  );
}
