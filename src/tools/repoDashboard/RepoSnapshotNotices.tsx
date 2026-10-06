import { ActionKey } from "../../ui/ActionKey";
import { Glyph } from "../../ui/Glyph";
import type { SnapshotNotice } from "./model";

/** Notices shown before the rest are folded behind the expand key. */
const COLLAPSED_COUNT = 2;
const LONG_NOTICE_CHARS = 110;

/** True when folding hides something: more than the collapsed count, or a line that would be cut off. */
export function noticesNeedToggle(notices: readonly SnapshotNotice[]): boolean {
  return notices.length > COLLAPSED_COUNT || notices.some(notice => notice.text.length > LONG_NOTICE_CHARS);
}

/**
 * Snapshot warnings (gh failures, capped or truncated data, history fallback, stale docs source) kept in
 * view above the sections instead of inside the collapsed Docs diagnostics. Collapsed: two single lines.
 */
export function RepoSnapshotNotices({
  notices,
  expanded,
  onToggle,
}: {
  notices: readonly SnapshotNotice[];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (notices.length === 0) return null;
  const shown = expanded ? notices : notices.slice(0, COLLAPSED_COUNT);
  const hidden = notices.length - shown.length;
  const warnings = notices.filter(notice => notice.tone === "warn").length;
  return (
    <div
      className={`repo-dashboard-notices${expanded ? " repo-dashboard-notices-expanded" : ""}`}
      data-tone={warnings > 0 ? "warn" : "info"}
      role="status"
      aria-label="Snapshot warnings"
    >
      <ul className="repo-dashboard-notices-list">
        {shown.map(notice => (
          <li key={notice.id} className={`repo-dashboard-notice repo-dashboard-notice-${notice.tone}`}>
            <Glyph name={notice.tone === "warn" ? "conflict" : "none"} tone={notice.tone === "warn" ? "warn" : "dim"} />
            <span className="visually-hidden">{notice.tone === "warn" ? "warning: " : "note: "}</span>
            <span className="repo-dashboard-notice-text" title={notice.text}>
              {notice.text}
            </span>
          </li>
        ))}
      </ul>
      {noticesNeedToggle(notices) ? (
        <ActionKey keys={["w"]} shortcut="w" onClick={onToggle} className="repo-dashboard-notices-toggle">
          {expanded ? "fewer" : hidden > 0 ? `${hidden} more` : "full text"}
        </ActionKey>
      ) : null}
    </div>
  );
}
