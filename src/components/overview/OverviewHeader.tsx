import type { OverviewSummaryModel } from "../../lib/overviewModel";
import { formatCheckedAt } from "../../shell/Sidebar";
import { StateMark } from "../../ui/StatePill";

export interface OverviewHeaderProps {
  summary: Pick<OverviewSummaryModel, "headline" | "parts" | "failedChecks">;
  /** When the status was last fetched; null before the first check. */
  checkedAt: Date | null;
}

/**
 * The Overview's two lines. Line one answers "is it OK?" in a short sentence with no coloured words and no counts;
 * line two answers "what do I do?": only the states that are not zero, each with its marker (a hollow ring, the filled
 * square for decisions), then when the status was read. States that are zero are left out, so the line gets shorter as
 * things settle. It is a polite live region: taking a decision changes both lines.
 */
export function OverviewHeader({ summary, checkedAt }: OverviewHeaderProps) {
  const meta = [
    checkedAt ? `Checked ${formatCheckedAt(checkedAt)}, nothing written` : null,
    summary.failedChecks > 0 ? `${summary.failedChecks} ${summary.failedChecks === 1 ? "check" : "checks"} failed` : null,
  ].filter(Boolean);
  return (
    <header className="ov-head" aria-live="polite">
      <h2 className="ov-title">{summary.headline}</h2>
      <ul className="ov-sumrow" aria-label="Counts by state">
        {summary.parts.map(part => (
          <li key={part.state} className={`ov-si is-${part.state}`}>
            <StateMark state={part.state} />
            <b>{part.count}</b>
            {part.text.slice(String(part.count).length)}
          </li>
        ))}
        {meta.length > 0 && <li className="ov-si ov-meta">{meta.join(" · ")}</li>}
      </ul>
    </header>
  );
}
