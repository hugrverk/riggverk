const withLf = (text: string): string => text.replace(/\r\n/g, "\n");

/**
 * The lines of a text, compared without their endings: CRLF reads as LF (a textarea hands back LF whatever the file
 * had), and the final newline is a property of the text, not an empty last line, so appending a line does not show a
 * removed blank one. "" has no lines.
 */
function linesOf(text: string): string[] {
  const lf = withLf(text);
  if (lf === "") return [];
  const lines = lf.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * What differs when the diff of two different texts shows no line: only the line endings (CRLF against LF) or only
 * the final newline. Null when the texts are equal, or when a line differs.
 */
export function endingsOnlyNote(before: string, after: string): string | null {
  if (before === after || unifiedLineDiff(before, after) !== "") return null;
  return withLf(before) === withLf(after) ? "Only the line endings differ." : "Only the final newline differs.";
}

/**
 * A line diff of two texts as unified-diff lines (`+`, `-` or a space in front of every line, no file labels),
 * the shape `DiffView` reads. Unchanged stretches longer than the context around a change are folded into one
 * `@@ N unchanged lines @@` line. Line endings are not compared (CRLF equals LF) and the final newline is not a
 * line: returns "" when no line differs; `endingsOnlyNote` says so when the texts still differ in bytes.
 */
export function unifiedLineDiff(before: string, after: string, context = 3): string {
  if (before === after) return "";
  const ops = diffOps(linesOf(before), linesOf(after));
  if (!ops.some(op => op.mark !== " ")) return "";
  const out: string[] = [];
  let run: string[] = [];
  const flush = (leading: boolean, trailing: boolean) => {
    if (run.length === 0) return;
    const keepHead = leading ? 0 : context;
    const keepTail = trailing ? 0 : context;
    if (run.length > keepHead + keepTail + 1) {
      out.push(...run.slice(0, keepHead));
      out.push(`@@ ${run.length - keepHead - keepTail} unchanged lines @@`);
      out.push(...run.slice(run.length - keepTail));
    } else {
      out.push(...run);
    }
    run = [];
  };
  let seenChange = false;
  for (const op of ops) {
    if (op.mark === " ") {
      run.push(` ${op.text}`);
      continue;
    }
    flush(!seenChange, false);
    seenChange = true;
    out.push(`${op.mark}${op.text}`);
  }
  flush(false, true);
  return out.join("\n");
}

interface Op {
  mark: " " | "-" | "+";
  text: string;
}

/** Texts this large are compared as one removal and one addition instead of an LCS table. */
const MAX_CELLS = 4_000_000;

function diffOps(a: string[], b: string[]): Op[] {
  // Trim what both texts share at either end first: most edits touch a few lines of a long file.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const ops: Op[] = a.slice(0, head).map((text): Op => ({ mark: " ", text }));
  ops.push(...diffMiddle(a.slice(head, a.length - tail), b.slice(head, b.length - tail)));
  ops.push(...a.slice(a.length - tail).map((text): Op => ({ mark: " ", text })));
  return ops;
}

function diffMiddle(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) {
    return [...a.map((text): Op => ({ mark: "-", text })), ...b.map((text): Op => ({ mark: "+", text }))];
  }
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ mark: " ", text: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      ops.push({ mark: "-", text: a[i]! });
      i += 1;
    } else {
      ops.push({ mark: "+", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) ops.push({ mark: "-", text: a[i++]! });
  while (j < m) ops.push({ mark: "+", text: b[j++]! });
  return ops;
}
