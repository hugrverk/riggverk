/**
 * The routing line of an imported skill, as the app writes it into `packs/imported/routing.md`:
 * `- {when}: \`{name}\`.` These mirror `routing_line` and `own_when` in `src-tauri/src/pack_routing.rs`, which stay
 * the authority; here they only fill and check the "Use when" field as it is typed.
 */

/** Longest routing line, in characters (the backend's `MAX_LINE_CHARS`). */
const MAX_LINE_CHARS = 240;

/** Control and invisible characters (Cc, Cf, Zl, Zp, default-ignorable code points, the blank Braille pattern). */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/u;

/** The line the app writes for `name`. */
export function routingLine(when: string, name: string): string {
  return `- ${when.trim()}: \`${name}\`.`;
}

/** Why `when` cannot become a routing line for `name`, or "". */
export function whenProblem(when: string, name: string): string {
  const text = when.trim();
  if (text === "") return "Say when an agent should use it.";
  if (INVISIBLE.test(when)) return "Remove the line break or invisible character.";
  if (text.startsWith("#") || /[`<@]/.test(text) || text.includes("~~~")) return "Plain words only: no backticks, <, @ or a leading #.";
  if (Array.from(routingLine(when, name)).length > MAX_LINE_CHARS) return `Keep the line under ${MAX_LINE_CHARS} characters.`;
  return "";
}

/**
 * A "Use when" suggestion from a skill's description: the first clause after "Use when" or "Use it when" that is not
 * negated ("Do not use when …" says the opposite), up to the end of its sentence, whitespace collapsed and with a
 * capital first letter. "" when there is none or it would not make a valid line.
 */
export function suggestWhen(description: string, name: string): string {
  const text = description.replace(/\s+/g, " ");
  for (const match of text.matchAll(/\buse (?:it )?when (.*?)(?:\.(?= |$)|$)/gi)) {
    if (/\b(?:not|never|don't|n't)\s*$/i.test(text.slice(0, match.index))) continue;
    const clause = match[1]!.trim();
    if (clause === "") return "";
    const suggestion = clause[0]!.toUpperCase() + clause.slice(1);
    return whenProblem(suggestion, name) === "" ? suggestion : "";
  }
  return "";
}

/** The "Use when" text of the line the app wrote for `name` among `lines`, or null when there is none. */
export function ownWhen(lines: readonly string[], name: string): string | null {
  const suffix = `: \`${name}\`.`;
  for (const line of lines) {
    const text = line.trimEnd();
    if (!text.startsWith("- ") || !text.endsWith(suffix)) continue;
    const when = text.slice(2, -suffix.length);
    if (when !== "" && !when.includes("`")) return when;
  }
  return null;
}

/** Lines among `lines` that name `name` but were not written by the app (kept as they are). */
export function handWritten(lines: readonly string[], name: string): string[] {
  return lines.filter(line => line.includes(`\`${name}\``) && ownWhen([line], name) === null);
}
