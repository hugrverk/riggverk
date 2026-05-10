export interface DesignMdColorToken {
  key: string;
  value: string;
}

export interface DesignMdTypographyToken {
  key: string;
  value: string;
}

export interface DesignMdComponentToken {
  key: string;
  value: string;
}

export interface DesignMdPreviewModel {
  slug: string;
  title: string;
  description: string;
  colors: DesignMdColorToken[];
  typography: DesignMdTypographyToken[];
  components: DesignMdComponentToken[];
  overviewText: string | null;
  layoutText: string | null;
  guardrailDos: string[];
  guardrailDonts: string[];
}

type YValue = string | YMap;
type YMap = Map<string, YValue>;

// ── nested YAML parser ──

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

const BLOCK_INDICATORS = new Set(["|", "|-", ">", ">-"]);

/**
 * Parse a simple subset of YAML frontmatter into a nested Map.
 * Handles scalars, nested objects, block scalars, quoted values.
 * No arrays, no anchors, no tags. Never throws.
 */
function parseYamlBody(lines: string[]): YMap {
  const root: YMap = new Map();
  const stack: { prefix: string[]; map: YMap }[] = [{ prefix: [], map: root }];
  let blockKey: string | null = null;
  let blockLines: string[] = [];
  let blockIndent = 0;

  for (const rawLine of lines) {
    const content = rawLine.trimEnd();
    if (content.trim().length === 0) {
      if (blockKey !== null && blockLines.length > 0) {
        setAt(root, stack, blockKey, blockLines.join(" "));
      }
      blockKey = null;
      blockLines = [];
      continue;
    }

    if (blockKey !== null) {
      const indent = rawLine.length - rawLine.trimStart().length;
      if (indent >= blockIndent) {
        blockLines.push(content.trim());
        continue;
      }
      // Indent decreased — end block scalar
      setAt(root, stack, blockKey, blockLines.join(" "));
      blockKey = null;
      blockLines = [];
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const trimmed = content.trim();
    const commentIdx = trimmed.indexOf(" #");
    const cleanLine = commentIdx !== -1 ? trimmed.slice(0, commentIdx).trimEnd() : trimmed;
    if (cleanLine.length === 0) continue;

    const colonIdx = cleanLine.indexOf(":");
    if (colonIdx === -1) continue;

    const key = cleanLine.slice(0, colonIdx).trim();
    const rawVal = cleanLine.slice(colonIdx + 1).trim();

    // Pop stack to correct indentation level
    while (stack.length > 1 && indent <= stack[stack.length - 1].prefix.length * 2) {
      stack.pop();
    }

    if (rawVal.length === 0 || BLOCK_INDICATORS.has(rawVal)) {
      // Nested object or block scalar
      if (BLOCK_INDICATORS.has(rawVal)) {
        blockKey = key;
        blockLines = [];
        blockIndent = indent + 2;
      } else {
        // Nested object — push stack and recurse on subsequent indented lines
        const childMap: YMap = new Map();
        setAt(root, stack, key, childMap);
        stack.push({ prefix: [...stack[stack.length - 1].prefix, key], map: childMap });
      }
    } else {
      setAt(root, stack, key, stripQuotes(rawVal));
    }
  }

  if (blockKey !== null && blockLines.length > 0) {
    setAt(root, stack, blockKey, blockLines.join(" "));
  }

  return root;
}

function setAt(root: YMap, stack: { prefix: string[]; map: YMap }[], key: string, value: YValue) {
  let current = root;
  // Walk the prefix path to the right nesting level
  for (const frame of stack) {
    if (frame === stack[0]) continue; // skip root frame
    for (const seg of frame.prefix) {
      const next = current.get(seg);
      if (next instanceof Map) {
        current = next;
      } else {
        const m = new Map();
        current.set(seg, m);
        current = m;
      }
    }
  }
  // Now at the stack top's map
  const top = stack[stack.length - 1].map;
  top.set(key, value);
}

// ── flatten nested YAML to dot-path map ──

function flattenMap(map: YMap, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of map) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value instanceof Map) {
      const sub = flattenMap(value, path);
      for (const [k, v] of sub) result.set(k, v);
    } else {
      result.set(path, value);
    }
  }
  return result;
}

/** Parse the YAML frontmatter from DESIGN.md into a flat dot-path key-value map. */
function parseNestedFrontmatter(content: string): Map<string, string> {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return new Map();

  const afterOpen = trimmed.slice(3).trimStart().replace(/^\n+/, "");
  const closingIdx = afterOpen.indexOf("\n---");
  const fmStr = closingIdx === -1 ? afterOpen : afterOpen.slice(0, closingIdx);

  const lines = fmStr.split("\n");
  const yaml = parseYamlBody(lines);
  return flattenMap(yaml);
}

// legacy alias for GeneratedPreview
export const parseFlatFrontmatter = parseNestedFrontmatter;

// ── token extraction (dot-path aware) ──

function extractNested(map: Map<string, string>, prefix: string): DesignMdColorToken[] {
  const tokens: DesignMdColorToken[] = [];
  const dot = prefix + ".";
  for (const [key, value] of map) {
    if (key.startsWith(dot)) {
      tokens.push({ key: key.slice(dot.length), value });
    }
  }
  return tokens;
}

// ── token reference resolution ──

/** Resolve {token.path} references against the flat map. Returns resolved string or original. */
function resolveRefs(value: string, map: Map<string, string>): string {
  return value.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const resolved = map.get(key.trim());
    return resolved ?? `{${key}}`;
  });
}

/** Resolve all token values' references. */
function resolveTokens(tokens: { key: string; value: string }[], map: Map<string, string>): { key: string; value: string }[] {
  return tokens.map(t => ({ ...t, value: resolveRefs(t.value, map) }));
}

// ── markdown body extraction ──

function extractSection(body: string, heading: string): string | null {
  const re = new RegExp(`^#{1,3}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im");
  const match = body.match(re);
  if (!match || match.index === undefined) return null;
  const after = body.slice(match.index + match[0].length);
  const nextHeading = after.match(/\n#{1,3}\s/);
  const section = nextHeading ? after.slice(0, nextHeading.index).trim() : after.trim();
  const lines = section.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  return lines.slice(0, 6).join(" ").trim();
}

function extractListItems(body: string, heading: string): string[] {
  const section = extractSection(body, heading);
  if (!section) return [];
  return section
    .split("\n")
    .filter((l) => /^[-*]\s/.test(l.trim()))
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .slice(0, 10);
}

// ── main parse entry ──

export function parseDesignMdForPreview(
  slug: string,
  title: string,
  description: string,
  content: string,
): DesignMdPreviewModel {
  const fmBodyStart = content.indexOf("---", 3);
  const body = fmBodyStart === -1 ? "" : content.slice(fmBodyStart + 3);

  const fm = parseNestedFrontmatter(content);

  const colors = resolveTokens(extractNested(fm, "colors"), fm);
  const typography = resolveTokens(extractNested(fm, "typography"), fm);
  const components = resolveTokens(extractNested(fm, "components"), fm);
  const overviewText = extractSection(body, "Overview");
  const layoutText = extractSection(body, "Layout");
  const guardrailDos = extractListItems(body, "Do");
  const guardrailDonts = extractListItems(body, "Don't");

  return {
    slug,
    title,
    description,
    colors,
    typography,
    components,
    overviewText,
    layoutText,
    guardrailDos,
    guardrailDonts,
  };
}

// ── sanitization helpers ──

function isSafeColor(val: string): boolean {
  return /^#[0-9a-fA-F]{3,8}$/.test(val) || /^rgba?\s*\([^)]+\)$/.test(val) || /^hsl/.test(val);
}

function isSafeSize(val: string): boolean {
  return /^-?\d+(\.\d+)?(px|rem|em|%|ch|vh|vw|pt)?$/.test(val.trim());
}

function isSafeFontFamily(val: string): string | null {
  const clean = val.replace(/['"]/g, "").trim();
  if (/[<>;{}()]|url\s*\(/i.test(clean)) return null;
  return clean;
}

export function safeColorStyle(val: string): Record<string, string> | null {
  if (isSafeColor(val)) return { backgroundColor: val };
  return null;
}

export function safeTypoStyle(
  fontSize: string | undefined,
  fontWeight: string | undefined,
  lineHeight: string | undefined,
  fontFamily: string | undefined,
): Record<string, string> {
  const style: Record<string, string> = {};
  if (fontSize && isSafeSize(fontSize)) style.fontSize = fontSize;
  if (fontWeight && /^\d{3}$|bold|normal|lighter|bolder/.test(fontWeight)) style.fontWeight = fontWeight;
  if (lineHeight) style.lineHeight = lineHeight;
  if (fontFamily) {
    const safe = isSafeFontFamily(fontFamily);
    if (safe) style.fontFamily = safe;
  }
  return style;
}

export function safeButtonStyle(fm: Map<string, string>): Record<string, string> {
  const style: Record<string, string> = {};
  const bg = fm.get("components.button-primary.backgroundColor");
  const color = fm.get("components.button-primary.textColor");
  const radius = fm.get("components.button-primary.rounded");
  if (bg && isSafeColor(bg)) { style.backgroundColor = bg; style.borderColor = bg; }
  if (color && isSafeColor(color)) style.color = color;
  if (radius && isSafeSize(radius)) style.borderRadius = radius;
  return style;
}

export function safeCardStyle(fm: Map<string, string>): Record<string, string> {
  const style: Record<string, string> = {};
  const bg = fm.get("components.card.backgroundColor") || fm.get("components.card.background");
  const radius = fm.get("components.card.borderRadius") || fm.get("components.card.rounded");
  if (bg && isSafeColor(bg)) style.backgroundColor = bg;
  if (radius && isSafeSize(radius)) style.borderRadius = radius;
  return style;
}

