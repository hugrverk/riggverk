/**
 * Pure command-line parsing. No DOM, no React.
 *
 * `update --all`, `theme dark`, `library skills "current docs"`. The first token resolves to a command by
 * exact name/alias or by unique prefix; enum values resolve the same way. Ambiguity is an error that carries
 * the candidates so the command line can offer them.
 */

export type ArgKind = "enum" | "flag" | "rest";

export interface ArgSpec {
  /** Key in `ParsedCommand.named` (enum/rest) or the flag name without dashes (flag). */
  name: string;
  kind: ArgKind;
  /** enum: allowed values, static or computed on demand. */
  values?: readonly string[] | (() => readonly string[]);
  optional?: boolean;
  description?: string;
  /** enum: per-value description shown next to a suggestion. */
  describe?: (value: string) => string | undefined;
}

export interface CompletionItem {
  value: string;
  description?: string;
  /** Reason the completion cannot run right now. */
  disabled?: string;
}

export interface CompleteContext {
  /** Positional values typed before the one being completed. */
  args: string[];
  flags: Record<string, true | string>;
  /** Text typed for the token being completed ("" after a trailing space). */
  partial: string;
}

export interface ParsedCommand {
  ok: true;
  cmd: CommandSpec;
  /** Positional values in order (enum values canonicalised, `rest` joined with spaces). */
  args: string[];
  /** Positional values by arg name. */
  named: Record<string, string>;
  flags: Record<string, true | string>;
  input: string;
}

export interface ParseFailure {
  ok: false;
  error: string;
  /** Candidates to offer: ambiguous commands, or every command when the line is empty. */
  suggestions: CommandSpec[];
}

export type ParseResult = ParsedCommand | ParseFailure;

export interface CommandSpec {
  /** Canonical name, lower-case: "update", "release-check". */
  name: string;
  aliases?: readonly string[];
  summary: string;
  group?: string;
  args?: readonly ArgSpec[];
  /** Extra dynamic completions (library items, ...). Static enum values are completed automatically. */
  complete?: (context: CompleteContext) => CompletionItem[];
  /** Cross-argument validation. Return an error message, or null when valid. */
  validate?: (parsed: ParsedCommand) => string | null;
  /** true when runnable; a string is the reason it is not (shown in suggestions and as the error). */
  enabled?: () => true | string;
  run: (parsed: ParsedCommand) => void | Promise<void>;
}

export interface Token {
  text: string;
  quoted: boolean;
  start: number;
  end: number;
}

export interface TokenizeResult {
  tokens: Token[];
  /** Set when a quote is never closed (strict mode); lenient mode keeps the partial token instead. */
  unterminated: boolean;
}

/** Splits on whitespace, honouring single and double quotes and backslash escapes. */
export function tokenize(input: string): TokenizeResult {
  const tokens: Token[] = [];
  let i = 0;
  let unterminated = false;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i]!)) i++;
    if (i >= input.length) break;
    const start = i;
    let text = "";
    let quoted = false;
    let quote: string | null = null;
    while (i < input.length) {
      const ch = input[i]!;
      if (quote) {
        if (ch === "\\" && i + 1 < input.length && (input[i + 1] === quote || input[i + 1] === "\\")) {
          text += input[i + 1];
          i += 2;
          continue;
        }
        if (ch === quote) {
          quote = null;
          i++;
          continue;
        }
        text += ch;
        i++;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === '"' || ch === "'") {
        quote = ch;
        quoted = true;
        i++;
        continue;
      }
      if (ch === "\\" && i + 1 < input.length) {
        text += input[i + 1];
        i += 2;
        continue;
      }
      text += ch;
      i++;
    }
    if (quote) unterminated = true;
    tokens.push({ text, quoted, start, end: i });
  }
  return { tokens, unterminated };
}

export function enumValues(arg: ArgSpec): readonly string[] {
  if (!arg.values) return [];
  return typeof arg.values === "function" ? arg.values() : arg.values;
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Distinct commands whose name or alias equals (exact) or starts with (prefix) `word`. */
export function resolveCommand(
  word: string,
  commands: readonly CommandSpec[],
): { exact: CommandSpec | null; prefix: CommandSpec[] } {
  const lower = word.toLowerCase();
  const exact = commands.find(cmd => sameName(cmd.name, lower) || (cmd.aliases ?? []).some(alias => sameName(alias, lower)));
  if (exact) return { exact, prefix: [exact] };
  const prefix = commands.filter(cmd =>
    cmd.name.toLowerCase().startsWith(lower) || (cmd.aliases ?? []).some(alias => alias.toLowerCase().startsWith(lower)),
  );
  return { exact: null, prefix };
}

/** Resolves `word` among `values` by exact or unique-prefix match. */
export function resolveValue(word: string, values: readonly string[]): { value: string | null; candidates: string[] } {
  const lower = word.toLowerCase();
  const exact = values.find(value => value.toLowerCase() === lower);
  if (exact) return { value: exact, candidates: [exact] };
  const candidates = values.filter(value => value.toLowerCase().startsWith(lower));
  return { value: candidates.length === 1 ? candidates[0]! : null, candidates };
}

function fail(error: string, suggestions: CommandSpec[] = []): ParseFailure {
  return { ok: false, error, suggestions };
}

function resolveFlag(
  word: string,
  specs: readonly ArgSpec[],
): { name: string | null; candidates: string[] } {
  const names = specs.filter(spec => spec.kind === "flag").map(spec => spec.name);
  const { value, candidates } = resolveValue(word, names);
  return { name: value, candidates };
}

export function parseCommandLine(input: string, commands: readonly CommandSpec[]): ParseResult {
  const trimmed = input.trim().replace(/^:+\s*/, "");
  const { tokens, unterminated } = tokenize(trimmed);
  if (unterminated) return fail("unterminated quote");
  if (tokens.length === 0) return fail("type a command", [...commands]);

  const head = tokens[0]!;
  const { exact, prefix } = resolveCommand(head.text, commands);
  const cmd = exact ?? (prefix.length === 1 ? prefix[0]! : null);
  if (!cmd) {
    if (prefix.length === 0) return fail(`unknown command "${head.text}"`, []);
    return fail(`ambiguous command "${head.text}": ${prefix.map(c => c.name).join(", ")}`, prefix);
  }

  const argSpecs = cmd.args ?? [];
  const positionalSpecs = argSpecs.filter(spec => spec.kind !== "flag");
  const flags: Record<string, true | string> = {};
  const positionals: Token[] = [];
  for (const token of tokens.slice(1)) {
    if (!token.quoted && token.text.startsWith("--") && token.text.length > 2) {
      const [rawName, ...valueParts] = token.text.slice(2).split("=");
      const resolved = resolveFlag(rawName!, argSpecs);
      if (!resolved.name) {
        return fail(
          resolved.candidates.length > 1
            ? `ambiguous flag --${rawName}: ${resolved.candidates.map(n => `--${n}`).join(", ")}`
            : `${cmd.name}: unknown flag --${rawName}`,
        );
      }
      flags[resolved.name] = valueParts.length > 0 ? valueParts.join("=") : true;
      continue;
    }
    positionals.push(token);
  }

  const args: string[] = [];
  const named: Record<string, string> = {};
  let cursor = 0;
  for (const spec of positionalSpecs) {
    if (cursor >= positionals.length) break;
    if (spec.kind === "rest") {
      const value = positionals.slice(cursor).map(token => token.text).join(" ");
      args.push(value);
      named[spec.name] = value;
      cursor = positionals.length;
      break;
    }
    const raw = positionals[cursor]!.text;
    const allowed = enumValues(spec);
    const { value, candidates } = resolveValue(raw, allowed);
    if (!value) {
      return fail(
        candidates.length > 1
          ? `ambiguous ${spec.name} "${raw}": ${candidates.join(", ")}`
          : `${cmd.name}: invalid ${spec.name} "${raw}" (expected ${allowed.join(" | ")})`,
      );
    }
    args.push(value);
    named[spec.name] = value;
    cursor++;
  }
  if (cursor < positionals.length) return fail(`${cmd.name}: too many arguments`);

  const missing = positionalSpecs.find(spec => !spec.optional && named[spec.name] === undefined);
  // A command with its own validate() decides what a missing argument means (e.g. a flag replaces it).
  if (missing && !cmd.validate) return fail(`${cmd.name}: missing ${missing.name}`);

  const parsed: ParsedCommand = { ok: true, cmd, args, named, flags, input: trimmed };
  const invalid = cmd.validate ? cmd.validate(parsed) : null;
  if (invalid) return fail(invalid);
  return parsed;
}
