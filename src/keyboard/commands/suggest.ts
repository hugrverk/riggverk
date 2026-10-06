/** Pure suggestion engine for the command line. */

import {
  enumValues,
  parseCommandLine,
  resolveCommand,
  resolveValue,
  tokenize,
  type ArgSpec,
  type CommandSpec,
  type CompletionItem,
  type Token,
} from "./parser";

export interface Suggestion {
  /** The full command line this suggestion stands for: "update claude". */
  text: string;
  command: string;
  description?: string;
  /** Reason it cannot run right now (shown dimmed; running it reports the reason). */
  disabled?: string;
}

export interface SuggestOptions {
  limit?: number;
}

const DEFAULT_LIMIT = 8;
const MAX_EXPANSIONS_PER_COMMAND = 6;

function quote(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
}

function disabledReason(cmd: CommandSpec): string | undefined {
  const result = cmd.enabled ? cmd.enabled() : true;
  return result === true ? undefined : result;
}

function nameRank(cmd: CommandSpec, lower: string): number | null {
  const name = cmd.name.toLowerCase();
  const aliases = (cmd.aliases ?? []).map(alias => alias.toLowerCase());
  if (name === lower || aliases.includes(lower)) return 0;
  if (name.startsWith(lower)) return 1;
  if (aliases.some(alias => alias.startsWith(lower))) return 2;
  if (name.includes(lower)) return 3;
  return null;
}

function positionalSpecs(cmd: CommandSpec): ArgSpec[] {
  return (cmd.args ?? []).filter(spec => spec.kind !== "flag");
}

function flagSpecs(cmd: CommandSpec): ArgSpec[] {
  return (cmd.args ?? []).filter(spec => spec.kind === "flag");
}

function isFlagToken(token: Token): boolean {
  return !token.quoted && token.text.startsWith("--");
}

function dedupe(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.value)) return false;
    seen.add(item.value);
    return true;
  });
}

interface ArgContext {
  cmd: CommandSpec;
  priorTokens: Token[];
  priorArgs: string[];
  priorFlags: Record<string, true | string>;
  partial: string;
}

function completionItems(context: ArgContext): CompletionItem[] {
  const { cmd, priorArgs, priorFlags, partial } = context;
  const lower = partial.toLowerCase();
  const usedFlags = new Set(Object.keys(priorFlags));
  const flagItems = (prefix: string): CompletionItem[] =>
    flagSpecs(cmd)
      .filter(spec => !usedFlags.has(spec.name) && spec.name.toLowerCase().startsWith(prefix))
      .map(spec => ({ value: `--${spec.name}`, description: spec.description }));

  if (partial.startsWith("-")) return flagItems(partial.replace(/^-+/, "").toLowerCase());

  const specs = positionalSpecs(cmd);
  const last = specs[specs.length - 1];
  const spec = specs[priorArgs.length] ?? (last?.kind === "rest" ? last : undefined);
  const items: CompletionItem[] = [];
  if (spec?.kind === "enum") {
    for (const value of enumValues(spec)) {
      if (value.toLowerCase().startsWith(lower)) items.push({ value, description: spec.describe?.(value) });
    }
  }
  const custom = cmd.complete?.({ args: priorArgs, flags: priorFlags, partial }) ?? [];
  for (const item of custom) {
    if (item.value.toLowerCase().includes(lower)) items.push(item);
  }
  if (partial === "") items.push(...flagItems(""));
  return dedupe(items);
}

function nameSuggestions(word: string, commands: readonly CommandSpec[], limit: number): Suggestion[] {
  const lower = word.toLowerCase();
  const ranked = commands
    .map((cmd, order) => ({ cmd, order, rank: lower === "" ? 1 : nameRank(cmd, lower) }))
    .filter((entry): entry is { cmd: CommandSpec; order: number; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.order - b.order);

  const out: Suggestion[] = [];
  for (const { cmd } of ranked) {
    const disabled = disabledReason(cmd);
    const specs = positionalSpecs(cmd);
    const first = specs[0];
    // A command whose first argument is required is only useful with an argument: offer those lines instead.
    const needsArg = first !== undefined && !first.optional;
    const expansions = lower === "" ? [] : completionItems({ cmd, priorTokens: [], priorArgs: [], priorFlags: {}, partial: "" });
    if (!needsArg || expansions.length === 0) {
      out.push({ text: cmd.name, command: cmd.name, description: cmd.summary, disabled });
    }
    if (lower !== "") {
      for (const item of expansions.slice(0, MAX_EXPANSIONS_PER_COMMAND)) {
        out.push({
          text: `${cmd.name} ${quote(item.value)}`,
          command: cmd.name,
          description: item.description ?? cmd.summary,
          disabled: disabled ?? item.disabled,
        });
      }
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/**
 * Suggestions for the text currently in the command line.
 * - empty or first word: commands by exact / prefix / alias / substring, with their argument lines expanded;
 * - after the command: enum values, flags and the command's own completions for the current argument.
 */
export function suggest(input: string, commands: readonly CommandSpec[], options: SuggestOptions = {}): Suggestion[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const line = input.replace(/^\s*:+\s*/, "");
  const endsWithSpace = /\s$/.test(line);
  const tokens = tokenize(line).tokens;

  if (tokens.length === 0) return nameSuggestions("", commands, limit);
  if (tokens.length === 1 && !endsWithSpace && !isFlagToken(tokens[0]!)) {
    return nameSuggestions(tokens[0]!.text, commands, limit);
  }

  const head = tokens[0]!;
  const { exact, prefix } = resolveCommand(head.text, commands);
  const cmd = exact ?? (prefix.length === 1 ? prefix[0]! : null);
  if (!cmd) return nameSuggestions(head.text, commands, limit);

  const rest = tokens.slice(1);
  const partialToken = endsWithSpace ? null : rest[rest.length - 1] ?? null;
  const priorTokens = partialToken ? rest.slice(0, -1) : rest;
  const priorArgs: string[] = [];
  const priorFlags: Record<string, true | string> = {};
  const specs = positionalSpecs(cmd);
  for (const token of priorTokens) {
    if (isFlagToken(token)) {
      const [rawName, ...valueParts] = token.text.slice(2).split("=");
      const flag = resolveValue(rawName!, flagSpecs(cmd).map(spec => spec.name)).value;
      if (flag) priorFlags[flag] = valueParts.length > 0 ? valueParts.join("=") : true;
      continue;
    }
    const spec = specs[priorArgs.length];
    const canonical = spec?.kind === "enum" ? resolveValue(token.text, enumValues(spec)).value ?? token.text : token.text;
    priorArgs.push(canonical);
  }

  const partial = partialToken?.text ?? "";
  const disabled = disabledReason(cmd);
  const lead = [cmd.name, ...priorTokens.map(token => (isFlagToken(token) ? token.text : quote(token.text)))];
  const items = completionItems({ cmd, priorTokens, priorArgs, priorFlags, partial });
  const suggestions: Suggestion[] = items.slice(0, limit).map(item => ({
    text: [...lead, quote(item.value)].join(" "),
    command: cmd.name,
    description: item.description ?? cmd.summary,
    disabled: disabled ?? item.disabled,
  }));
  if (suggestions.length > 0) return suggestions;

  // Nothing left to complete: show the line itself when it is a valid command.
  const parsed = parseCommandLine(line, commands);
  return parsed.ok ? [{ text: line.trim(), command: cmd.name, description: cmd.summary, disabled }] : [];
}
