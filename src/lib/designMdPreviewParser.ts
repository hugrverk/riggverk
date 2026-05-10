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

/** Parse a raw YAML value: strip quotes, trim. */
function parseYamlValue(raw: string): string {
  let v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

/** Parse the YAML frontmatter from DESIGN.md content into a flat key-value map. */
export function parseFlatFrontmatter(content: string): Map<string, string> {
  const map = new Map<string, string>();
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return map;

  const afterOpen = trimmed.slice(3).trimStart().replace(/^\n+/, "");
  const closingIdx = afterOpen.indexOf("\n---");
  const fmBody = closingIdx === -1 ? afterOpen : afterOpen.slice(0, closingIdx);

  let currentKey: string | null = null;
  let blockLines: string[] = [];

  for (const line of fmBody.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      if (currentKey !== null && blockLines.length > 0) {
        map.set(currentKey, blockLines.join(" "));
      }
      currentKey = null;
      blockLines = [];
      continue;
    }

    // Check for block scalar indicator (value is | or >)
    const colonIdx = trimmedLine.indexOf(":");
    if (colonIdx !== -1 && !line.startsWith(" ") && !line.startsWith("\t")) {
      // New key-value pair
      if (currentKey !== null && blockLines.length > 0) {
        map.set(currentKey, blockLines.join(" "));
      }
      const key = trimmedLine.slice(0, colonIdx).trim();
      const rawVal = trimmedLine.slice(colonIdx + 1).trim();
      if (rawVal === "|" || rawVal === "|-" || rawVal === ">" || rawVal === ">-") {
        currentKey = key;
        blockLines = [];
      } else {
        map.set(key, parseYamlValue(rawVal));
        currentKey = null;
        blockLines = [];
      }
    } else if (currentKey !== null) {
      // Continuation of block scalar
      blockLines.push(trimmedLine);
    }
  }

  if (currentKey !== null && blockLines.length > 0) {
    map.set(currentKey, blockLines.join(" "));
  }

  return map;
}

/** Extract nested keys like colors.primary, typography.font-size-base from a flat map. */
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

function extractTypoTokens(map: Map<string, string>, prefix: string): DesignMdTypographyToken[] {
  const tokens: DesignMdTypographyToken[] = [];
  const dot = prefix + ".";
  for (const [key, value] of map) {
    if (key.startsWith(dot)) {
      tokens.push({ key: key.slice(dot.length), value });
    }
  }
  return tokens;
}

function extractComponentTokens(map: Map<string, string>, prefix: string): DesignMdComponentToken[] {
  const tokens: DesignMdComponentToken[] = [];
  const dot = prefix + ".";
  for (const [key, value] of map) {
    if (key.startsWith(dot)) {
      tokens.push({ key: key.slice(dot.length), value });
    }
  }
  return tokens;
}

/** Extract the first meaningful paragraph from markdown body after a heading match. */
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

export function parseDesignMdForPreview(
  slug: string,
  title: string,
  description: string,
  content: string,
): DesignMdPreviewModel {
  const fmBodyStart = content.indexOf("---", 3);
  const body = fmBodyStart === -1 ? "" : content.slice(fmBodyStart + 3);

  const fm = parseFlatFrontmatter(content);

  const colors = extractNested(fm, "colors");
  const typography = extractTypoTokens(fm, "typography");
  const components = extractComponentTokens(fm, "components");
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

/** Return true if a color value is a valid hex or rgb/rgba string. */
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

/** Build sanitized style object for a color value. Returns null if unsafe. */
export function safeColorStyle(val: string): Record<string, string> | null {
  if (isSafeColor(val)) return { backgroundColor: val };
  return null;
}

/** Build sanitized style object for typography values. */
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
  const bg = fm.get("components.button-background");
  const color = fm.get("components.button-text-color");
  const radius = fm.get("components.button-border-radius");
  const padding = fm.get("components.button-padding");
  const fs = fm.get("components.button-font-size");
  if (bg && isSafeColor(bg)) { style.backgroundColor = bg; style.borderColor = bg; }
  if (color && isSafeColor(color)) style.color = color;
  if (radius && isSafeSize(radius)) style.borderRadius = radius;
  if (fs && isSafeSize(fs)) style.fontSize = fs;
  if (padding) style.padding = padding;
  return style;
}

export function safeCardStyle(fm: Map<string, string>): Record<string, string> {
  const style: Record<string, string> = {};
  const bg = fm.get("components.card-background");
  const radius = fm.get("components.card-border-radius");
  const pad = fm.get("components.card-padding");
  if (bg && isSafeColor(bg)) style.backgroundColor = bg;
  if (radius && isSafeSize(radius)) style.borderRadius = radius;
  if (pad) style.padding = pad;
  return style;
}
