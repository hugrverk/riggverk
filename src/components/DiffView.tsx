import { useMemo } from "react";
import { cx } from "../ui/tone";

export type DiffLineKind = "file" | "hunk" | "add" | "remove" | "context" | "note";

export interface DiffLine {
  kind: DiffLineKind;
  /** The leading column: `+`, `-`, a space for context, empty for headers. */
  mark: string;
  text: string;
}

/**
 * Splits the backend's unified diff into typed lines. The first two lines are the `---`/`+++` labels when
 * present; after that the first character decides, so a removed line that reads `-- x` is not mistaken for a header.
 */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  if (diff === "") return [];
  const lines = diff.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const hasLabels = lines.length >= 2 && lines[0]!.startsWith("--- ") && lines[1]!.startsWith("+++ ");
  return lines.map((line, index): DiffLine => {
    if (hasLabels && index < 2) return { kind: "file", mark: "", text: line };
    if (line.startsWith("@@")) return { kind: "hunk", mark: "", text: line };
    if (line.startsWith("\\")) return { kind: "note", mark: "", text: line };
    if (line.startsWith("+")) return { kind: "add", mark: "+", text: line.slice(1) };
    if (line.startsWith("-")) return { kind: "remove", mark: "-", text: line.slice(1) };
    return { kind: "context", mark: " ", text: line.startsWith(" ") ? line.slice(1) : line };
  });
}

export interface DiffViewProps {
  /** Unified diff text. */
  diff: string;
  /** Accessible name of the diff. */
  label: string;
  /** Shown when the two sides are equal. */
  empty?: string;
}

/**
 * Read-only unified diff. Every changed line starts with a `+` or `-` in its own column, so the colour is never the
 * only signal; long lines wrap instead of scrolling sideways.
 */
export function DiffView({ diff, label, empty = "no differences" }: DiffViewProps) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  if (lines.length === 0) {
    return (
      <p className="c-dim diff-empty" role="status">
        {empty}
      </p>
    );
  }
  return (
    <div className="diff" role="group" aria-label={label}>
      {lines.map((line, index) => (
        <div key={index} className={cx("diff-line", line.kind)}>
          <span className="diff-mark">{line.mark || " "}</span>
          <span className="diff-text">{line.text === "" ? " " : line.text}</span>
        </div>
      ))}
    </div>
  );
}
