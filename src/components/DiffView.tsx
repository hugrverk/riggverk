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
 * A diff made without labels (`unifiedLineDiff`) says `labelled = false`: its first two lines may be a removed `-- x` and
 * an added `++ y`, which read as `--- x` and `+++ y`.
 */
export function parseUnifiedDiff(diff: string, labelled = true): DiffLine[] {
  if (diff === "") return [];
  const lines = diff.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const hasLabels = labelled && lines.length >= 2 && lines[0]!.startsWith("--- ") && lines[1]!.startsWith("+++ ");
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
  /** False for a diff without `---`/`+++` file labels, so its first lines are never taken for them. Default true. */
  labelled?: boolean;
  /** `unified` (default): one column, `+`/`-` in their own column. `split`: the old text left, the new text right. */
  layout?: "unified" | "split";
}

interface SplitSide {
  kind: "context" | "add" | "remove" | "blank";
  mark: string;
  text: string;
}

type SplitRow = { span: DiffLine } | { left: SplitSide; right: SplitSide };

const BLANK: SplitSide = { kind: "blank", mark: " ", text: "" };

/**
 * Lays a unified diff out as two columns: context on both sides, each run of removals on the left beside the run of
 * additions it was replaced by on the right, the shorter side padded with blanks so the rows line up.
 */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let removed: SplitSide[] = [];
  let added: SplitSide[] = [];
  const flush = () => {
    const count = Math.max(removed.length, added.length);
    for (let index = 0; index < count; index += 1) rows.push({ left: removed[index] ?? BLANK, right: added[index] ?? BLANK });
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.kind === "file") continue;
    if (line.kind === "remove") removed.push({ kind: "remove", mark: "-", text: line.text });
    else if (line.kind === "add") added.push({ kind: "add", mark: "+", text: line.text });
    else {
      flush();
      if (line.kind === "context") rows.push({ left: { kind: "context", mark: " ", text: line.text }, right: { kind: "context", mark: " ", text: line.text } });
      else rows.push({ span: line });
    }
  }
  flush();
  return rows;
}

function sideLabels(lines: readonly DiffLine[]): [string, string] {
  const files = lines.filter(line => line.kind === "file").map(line => line.text.replace(/^(---|\+\+\+) /, ""));
  return [files[0] ?? "before", files[1] ?? "after"];
}

function SplitCell({ side }: { side: SplitSide }) {
  return (
    <div className={cx("diff-line", side.kind)}>
      <span className="diff-mark">{side.mark}</span>
      <span className="diff-text">{side.text === "" ? " " : side.text}</span>
    </div>
  );
}

/**
 * Read-only diff. Every changed line starts with a `+` or `-` in its own column, so the colour is never the
 * only signal; long lines wrap instead of scrolling sideways. The `split` layout is the side-by-side Compare view.
 */
export function DiffView({ diff, label, empty = "no differences", layout = "unified", labelled = true }: DiffViewProps) {
  const lines = useMemo(() => parseUnifiedDiff(diff, labelled), [diff, labelled]);
  const rows = useMemo(() => (layout === "split" ? splitRows(lines) : []), [layout, lines]);
  // Labels alone are no difference.
  if (lines.every(line => line.kind === "file")) {
    return (
      <p className="c-dim diff-empty" role="status">
        {empty}
      </p>
    );
  }
  if (layout === "split") {
    const [before, after] = sideLabels(lines);
    return (
      <div className="diff diff-split" role="group" aria-label={label}>
        <div className="diff-head">
          <span>{before}</span>
          <span>{after}</span>
        </div>
        {rows.map((row, index) =>
          "span" in row ? (
            <div key={index} className={cx("diff-line", "diff-span", row.span.kind)}>
              <span className="diff-mark"> </span>
              <span className="diff-text">{row.span.text}</span>
            </div>
          ) : (
            <div key={index} className="diff-row">
              <SplitCell side={row.left} />
              <SplitCell side={row.right} />
            </div>
          ),
        )}
      </div>
    );
  }
  return (
    <div className="diff" role="group" aria-label={label}>
      {lines.map((line, index) => (
        <div key={index} className={cx("diff-line", line.kind)}>
          <span className="diff-mark">{line.mark || " "}</span>
          <span className="diff-text">{line.text === "" ? " " : line.text}</span>
        </div>
      ))}
    </div>
  );
}
