import { SectionChip } from "../lib/runtimeUi";
import { ToolIcon, type ToolIconName } from "./ToolIcon";

export interface TargetPageFact {
  label: string;
  tone?: "ok" | "warn" | "fail" | "muted";
}

interface TargetPageHeaderProps {
  title: string;
  summary: string;
  icon?: ToolIconName;
  facts?: TargetPageFact[];
  warning?: string;
}

export function TargetPageHeader({ title, summary, icon, facts, warning }: TargetPageHeaderProps) {
  return (
    <header className="target-page-header">
      <div className="target-page-title-row">
        <div className="target-page-title-group">
          {icon && (
            <span className="target-page-icon" aria-hidden="true">
              <ToolIcon name={icon} />
            </span>
          )}
          <h1 className="target-page-title">{title}</h1>
        </div>
        {facts && facts.length > 0 && (
          <div className="target-page-facts" aria-label={`${title} quick facts`}>
            {facts.map(f => (
              <SectionChip key={f.label} label={f.label} tone={f.tone ?? "muted"} />
            ))}
          </div>
        )}
      </div>
      <p className="target-page-summary">{summary}</p>
      {warning && (
        <p className="target-page-warning" role="status">
          {warning}
        </p>
      )}
    </header>
  );
}
