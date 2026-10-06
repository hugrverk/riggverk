//! Bounded line diff for rules previews.
//!
//! A plain longest-common-subsequence diff over lines: rules files are a few
//! kilobytes, so quadratic work on the changed middle is fine, and a size cap
//! keeps a pathological file from stalling the preview. No dependency.

/// Upper bound for the diff text returned to the UI.
pub const MAX_DIFF_BYTES: usize = 64 * 1024;
/// Lines of unchanged context around each hunk.
const CONTEXT_LINES: usize = 3;
/// Largest changed middle (rows times columns) compared line by line; a bigger
/// one is shown as a plain replacement.
const MAX_LCS_CELLS: usize = 4_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffOutput {
    /// Unified diff text; empty when both sides are equal.
    pub text: String,
    pub added: usize,
    pub removed: usize,
    /// True when the text was cut at `MAX_DIFF_BYTES`.
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Keep,
    Remove,
    Add,
}

struct Lines<'a> {
    items: Vec<&'a str>,
    /// The text does not end with a newline, so the last item has none.
    missing_final_newline: bool,
}

fn split_lines(text: &str) -> Lines<'_> {
    if text.is_empty() {
        return Lines {
            items: Vec::new(),
            missing_final_newline: false,
        };
    }
    let missing_final_newline = !text.ends_with('\n');
    let body = text.strip_suffix('\n').unwrap_or(text);
    Lines {
        items: body.split('\n').collect(),
        missing_final_newline,
    }
}

/// Edit script over the lines of `from` and `to`: one `Op` per output line,
/// paired with the index of the line it refers to.
fn edit_script(from: &[&str], to: &[&str]) -> Vec<(Op, usize)> {
    let prefix = from
        .iter()
        .zip(to.iter())
        .take_while(|(left, right)| left == right)
        .count();
    let suffix = from[prefix..]
        .iter()
        .rev()
        .zip(to[prefix..].iter().rev())
        .take_while(|(left, right)| left == right)
        .count();
    let from_mid = &from[prefix..from.len() - suffix];
    let to_mid = &to[prefix..to.len() - suffix];

    let mut script: Vec<(Op, usize)> = (0..prefix).map(|index| (Op::Keep, index)).collect();
    if from_mid.len().saturating_mul(to_mid.len()) > MAX_LCS_CELLS {
        script.extend((0..from_mid.len()).map(|index| (Op::Remove, prefix + index)));
        script.extend((0..to_mid.len()).map(|index| (Op::Add, prefix + index)));
    } else {
        script.extend(lcs_script(from_mid, to_mid, prefix));
    }
    // Kept suffix lines refer to `from` indices.
    let from_suffix_start = from.len() - suffix;
    script.extend((0..suffix).map(|index| (Op::Keep, from_suffix_start + index)));
    script
}

/// LCS over the changed middle. Remove/Keep indices are offsets into `from`,
/// Add indices into `to` (both shifted by `offset`).
fn lcs_script(from: &[&str], to: &[&str], offset: usize) -> Vec<(Op, usize)> {
    let rows = from.len();
    let cols = to.len();
    let width = cols + 1;
    let mut table = vec![0_u32; (rows + 1) * width];
    for row in (0..rows).rev() {
        for col in (0..cols).rev() {
            table[row * width + col] = if from[row] == to[col] {
                table[(row + 1) * width + col + 1] + 1
            } else {
                table[(row + 1) * width + col].max(table[row * width + col + 1])
            };
        }
    }
    let mut script = Vec::with_capacity(rows + cols);
    let (mut row, mut col) = (0, 0);
    while row < rows && col < cols {
        if from[row] == to[col] {
            script.push((Op::Keep, offset + row));
            row += 1;
            col += 1;
        } else if table[(row + 1) * width + col] >= table[row * width + col + 1] {
            script.push((Op::Remove, offset + row));
            row += 1;
        } else {
            script.push((Op::Add, offset + col));
            col += 1;
        }
    }
    script.extend((row..rows).map(|index| (Op::Remove, offset + index)));
    script.extend((col..cols).map(|index| (Op::Add, offset + index)));
    script
}

/// Number of lines that differ between two texts (removed plus added).
pub fn changed_line_count(from: &str, to: &str) -> usize {
    let (left, right) = (split_lines(from), split_lines(to));
    edit_script(&left.items, &right.items)
        .iter()
        .filter(|(op, _)| *op != Op::Keep)
        .count()
}

/// Unified diff of `from` against `to`, with three lines of context and the
/// text bounded to `MAX_DIFF_BYTES`.
pub fn unified_diff(from_label: &str, to_label: &str, from: &str, to: &str) -> DiffOutput {
    let (left, right) = (split_lines(from), split_lines(to));
    let script = edit_script(&left.items, &right.items);
    let removed = script.iter().filter(|(op, _)| *op == Op::Remove).count();
    let added = script.iter().filter(|(op, _)| *op == Op::Add).count();
    if removed == 0 && added == 0 {
        return DiffOutput {
            text: String::new(),
            added: 0,
            removed: 0,
            truncated: false,
        };
    }

    // Hunks: runs of changes with CONTEXT_LINES kept lines around them, merged
    // when their context overlaps.
    let change_positions: Vec<usize> = script
        .iter()
        .enumerate()
        .filter(|(_, (op, _))| *op != Op::Keep)
        .map(|(position, _)| position)
        .collect();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for position in change_positions {
        let start = position.saturating_sub(CONTEXT_LINES);
        let end = (position + CONTEXT_LINES + 1).min(script.len());
        match ranges.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => ranges.push((start, end)),
        }
    }

    // Line numbers (1-based) at the start of each script position.
    let mut from_line = Vec::with_capacity(script.len() + 1);
    let mut to_line = Vec::with_capacity(script.len() + 1);
    let (mut from_cursor, mut to_cursor) = (1_usize, 1_usize);
    for (op, _) in &script {
        from_line.push(from_cursor);
        to_line.push(to_cursor);
        match op {
            Op::Keep => {
                from_cursor += 1;
                to_cursor += 1;
            }
            Op::Remove => from_cursor += 1,
            Op::Add => to_cursor += 1,
        }
    }
    from_line.push(from_cursor);
    to_line.push(to_cursor);

    let mut text = format!("--- {from_label}\n+++ {to_label}\n");
    let mut truncated = false;
    'hunks: for (start, end) in ranges {
        let slice = &script[start..end];
        let from_count = slice.iter().filter(|(op, _)| *op != Op::Add).count();
        let to_count = slice.iter().filter(|(op, _)| *op != Op::Remove).count();
        let from_start = if from_count == 0 {
            from_line[start] - 1
        } else {
            from_line[start]
        };
        let to_start = if to_count == 0 {
            to_line[start] - 1
        } else {
            to_line[start]
        };
        let header = format!("@@ -{from_start},{from_count} +{to_start},{to_count} @@\n");
        if text.len() + header.len() > MAX_DIFF_BYTES {
            truncated = true;
            break;
        }
        text.push_str(&header);
        for (op, index) in slice {
            let (sign, line, last_without_newline) = match op {
                Op::Keep => (
                    ' ',
                    left.items[*index],
                    left.missing_final_newline && *index + 1 == left.items.len(),
                ),
                Op::Remove => (
                    '-',
                    left.items[*index],
                    left.missing_final_newline && *index + 1 == left.items.len(),
                ),
                Op::Add => (
                    '+',
                    right.items[*index],
                    right.missing_final_newline && *index + 1 == right.items.len(),
                ),
            };
            let mut rendered = format!("{sign}{line}\n");
            if last_without_newline {
                rendered.push_str("\\ No newline at end of file\n");
            }
            if text.len() + rendered.len() > MAX_DIFF_BYTES {
                truncated = true;
                break 'hunks;
            }
            text.push_str(&rendered);
        }
    }
    DiffOutput {
        text,
        added,
        removed,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_texts_have_an_empty_diff() {
        let diff = unified_diff("a", "b", "x\ny\n", "x\ny\n");
        assert_eq!(diff.text, "");
        assert_eq!((diff.added, diff.removed), (0, 0));
        assert!(!diff.truncated);
    }

    #[test]
    fn one_changed_line_gives_one_hunk_with_context() {
        let from = "1\n2\n3\n4\n5\n6\n7\n8\n";
        let to = "1\n2\n3\nfour\n5\n6\n7\n8\n";
        let diff = unified_diff("installed", "new", from, to);
        assert_eq!(
            diff.text,
            "--- installed\n+++ new\n@@ -1,7 +1,7 @@\n 1\n 2\n 3\n-4\n+four\n 5\n 6\n 7\n"
        );
        assert_eq!((diff.added, diff.removed), (1, 1));
    }

    #[test]
    fn distant_changes_make_separate_hunks() {
        let from: String = (1..=20).map(|n| format!("{n}\n")).collect();
        let to = from
            .replace("\n2\n", "\ntwo\n")
            .replace("\n19\n", "\nnineteen\n");
        let diff = unified_diff("a", "b", &from, &to);
        assert_eq!(diff.text.matches("@@ -").count(), 2, "{}", diff.text);
        assert!(diff.text.contains("-2\n+two\n"));
        assert!(diff.text.contains("-19\n+nineteen\n"));
    }

    #[test]
    fn insertions_and_deletions_are_reported() {
        let diff = unified_diff("a", "b", "keep\ngone\n", "keep\nnew one\nnew two\n");
        assert_eq!((diff.added, diff.removed), (2, 1));
        assert!(diff.text.contains("-gone\n"));
        assert!(diff.text.contains("+new one\n+new two\n"));
    }

    #[test]
    fn creating_and_emptying_a_file() {
        let created = unified_diff("a", "b", "", "one\ntwo\n");
        assert_eq!(created.text, "--- a\n+++ b\n@@ -0,0 +1,2 @@\n+one\n+two\n");
        let emptied = unified_diff("a", "b", "one\n", "");
        assert_eq!(emptied.text, "--- a\n+++ b\n@@ -1,1 +0,0 @@\n-one\n");
    }

    #[test]
    fn missing_final_newline_is_marked() {
        let diff = unified_diff("a", "b", "x\n", "x\ny");
        assert!(diff.text.contains("+y\n\\ No newline at end of file\n"));
    }

    #[test]
    fn output_is_bounded() {
        let from: String = (0..20_000).map(|n| format!("old line {n}\n")).collect();
        let to: String = (0..20_000).map(|n| format!("new line {n}\n")).collect();
        let diff = unified_diff("a", "b", &from, &to);
        assert!(diff.truncated);
        assert!(diff.text.len() <= MAX_DIFF_BYTES);
        assert_eq!(diff.removed, 20_000);
        assert_eq!(diff.added, 20_000);
    }

    #[test]
    fn changed_line_count_is_the_edit_distance_in_lines() {
        assert_eq!(changed_line_count("a\nb\nc\n", "a\nb\nc\n"), 0);
        assert_eq!(changed_line_count("a\nb\nc\n", "a\nx\nc\n"), 2);
        assert_eq!(changed_line_count("", "a\n"), 1);
    }
}
