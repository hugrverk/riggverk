export type DesignMdArchetype =
  | "product_gallery"
  | "marketplace"
  | "finance_dashboard"
  | "editorial"
  | "collaboration_saas"
  | "developer_docs"
  | "luxury_automotive"
  | "data_product"
  | "ai_product"
  | "creative_tool"
  | "payment_finance"
  | "music_campaign"
  | "terminal_tool"
  | "generic_system";

export type DesignMdComponentKind =
  | "button"
  | "card"
  | "pricing-card"
  | "stat-card"
  | "tile"
  | "product-tile"
  | "editorial-card"
  | "article-card"
  | "media-card"
  | "payment-card"
  | "market-table"
  | "workflow-step"
  | "prompt-input"
  | "terminal-panel"
  | "code-panel"
  | "search"
  | "input"
  | "chip"
  | "nav"
  | "subnav"
  | "link"
  | "quote"
  | "footer"
  | "badge"
  | "stat"
  | "table"
  | "chart"
  | "hero"
  | "gradient"
  | "mockup"
  | "utility"
  | "generic";

export interface DesignMdToken {
  key: string;
  rawValue: string;
  resolvedValue: string;
}

export interface DesignMdColorToken extends DesignMdToken {
  group: DesignMdPaletteGroupName;
}

export interface DesignMdTypographyToken {
  key: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
  raw: Record<string, string>;
}

export interface DesignMdComponentGroup {
  name: string;
  kind: DesignMdComponentKind;
  raw: Record<string, string>;
  styles: Record<string, string>;
}

export type DesignMdPaletteGroupName =
  | "brand/accent"
  | "canvas/surface"
  | "text/ink"
  | "muted"
  | "borders/hairlines"
  | "semantic/status";

export interface DesignMdPaletteGroup {
  name: DesignMdPaletteGroupName;
  tokens: DesignMdColorToken[];
}

export interface DesignMdVisualLanguage {
  phrases: string[];
  keywords: string[];
}

export interface DesignMdPreviewModel {
  meta: {
    slug: string;
    title: string;
    description: string;
  };
  palette: DesignMdPaletteGroup[];
  typography: DesignMdTypographyToken[];
  radius: DesignMdToken[];
  spacing: DesignMdToken[];
  components: DesignMdComponentGroup[];
  visualLanguage: DesignMdVisualLanguage;
  archetype: DesignMdArchetype;
  overviewText: string | null;
  layoutText: string | null;
  fontSubstitutes: string;
  guardrailDos: string[];
  guardrailDonts: string[];
}

type YValue = string | YMap;
type YMap = Map<string, YValue>;

const PALETTE_GROUPS: DesignMdPaletteGroupName[] = [
  "brand/accent",
  "canvas/surface",
  "text/ink",
  "muted",
  "borders/hairlines",
  "semantic/status",
];

const SECTION_HEADINGS = [
  "Overview",
  "Key Characteristics",
  "Layout",
  "Components",
  "Shapes",
  "Typography",
  "Colors",
  "Fonts",
  "Font Substitutes",
  "Font Substitute",
  "Note on Font Substitutes",
  "Font Notes",
];

const UNSAFE_VALUE_RE = /url\s*\(|@import|@font-face|expression\s*\(|var\s*\(|calc\s*\(|[;<>]|script|iframe|object|embed/i;

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

const BLOCK_INDICATORS = new Set(["|", "|-", ">", ">-"]);

function setNested(root: YMap, path: string[], key: string, value: YValue) {
  let current = root;
  for (const segment of path) {
    const next = current.get(segment);
    if (next instanceof Map) {
      current = next;
    } else {
      const child: YMap = new Map();
      current.set(segment, child);
      current = child;
    }
  }
  current.set(key, value);
}

function parseYamlBody(lines: string[]): YMap {
  const root: YMap = new Map();
  const stack: { indent: number; key: string }[] = [];
  let block: { indent: number; path: string[]; key: string; lines: string[] } | null = null;

  const flushBlock = () => {
    if (!block) return;
    setNested(root, block.path, block.key, block.lines.join(" ").trim());
    block = null;
  };

  for (const rawLine of lines) {
    const content = rawLine.trimEnd();
    const indent = rawLine.length - rawLine.trimStart().length;

    if (block) {
      if (content.trim().length === 0) {
        block.lines.push("");
        continue;
      }
      if (indent >= block.indent) {
        block.lines.push(content.trim());
        continue;
      }
      flushBlock();
    }

    const trimmed = content.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const commentIdx = trimmed.indexOf(" #");
    const cleanLine = commentIdx === -1 ? trimmed : trimmed.slice(0, commentIdx).trimEnd();
    const colonIdx = cleanLine.indexOf(":");
    if (colonIdx === -1) continue;

    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) stack.pop();

    const key = cleanLine.slice(0, colonIdx).trim();
    const rawVal = cleanLine.slice(colonIdx + 1).trim();
    const path = stack.map((frame) => frame.key);

    if (BLOCK_INDICATORS.has(rawVal)) {
      block = { indent: indent + 2, path, key, lines: [] };
      continue;
    }

    if (!rawVal) {
      setNested(root, path, key, new Map());
      stack.push({ indent, key });
      continue;
    }

    setNested(root, path, key, stripQuotes(rawVal));
  }

  flushBlock();
  return root;
}

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

function parseNestedFrontmatter(content: string): Map<string, string> {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return new Map();

  const afterOpen = trimmed.slice(3).replace(/^\s*\n/, "");
  const closing = afterOpen.match(/\n---\s*(\n|$)/);
  const fmStr = closing && closing.index !== undefined ? afterOpen.slice(0, closing.index) : afterOpen;

  try {
    return flattenMap(parseYamlBody(fmStr.split("\n")));
  } catch {
    return new Map();
  }
}

export const parseFlatFrontmatter = parseNestedFrontmatter;

export function isUnsafeDesignMdStyleValue(value: string): boolean {
  return UNSAFE_VALUE_RE.test(value);
}

export function resolveTokenRef(value: string, map: Map<string, string>): string {
  let result = value.trim();
  let prev = "";
  for (let i = 0; i < 4 && prev !== result; i += 1) {
    prev = result;
    result = result.replace(/\{([^}]+)\}/g, (_, key: string) => {
      const resolved = map.get(key.trim());
      return resolved ?? `{${key}}`;
    });
  }
  return result;
}

export function isSafeColorValue(value: string | undefined): value is string {
  if (!value || isUnsafeDesignMdStyleValue(value)) return false;
  const t = value.trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(t) || /^rgba?\(\s*[\d.\s,%]+\)$/.test(t) || /^hsla?\(\s*[\d.\s,%]+\)$/.test(t) || t === "transparent";
}

export function isSafeSizeValue(value: string | undefined): value is string {
  if (!value || isUnsafeDesignMdStyleValue(value)) return false;
  return /^-?\d+(\.\d+)?(px|rem|em|%|ch|vh|vw|pt)?$/.test(value.trim());
}

export function isSafeSpacingValue(value: string | undefined): value is string {
  if (!value || isUnsafeDesignMdStyleValue(value)) return false;
  return /^-?\d+(\.\d+)?(px|rem|em|%|ch|vh|vw|pt)?(\s+-?\d+(\.\d+)?(px|rem|em|%|ch|vh|vw|pt)?){0,3}$/.test(value.trim());
}

export function isSafeFontFamilyValue(value: string | undefined): value is string {
  if (!value || isUnsafeDesignMdStyleValue(value)) return false;
  return /^[\w\s"',.-]+$/.test(value.trim());
}

function normalizeFontName(value: string): string | null {
  const name = stripQuotes(value).trim();
  if (!name || !isSafeFontFamilyValue(name)) return null;
  const generic = /^(?:serif|sans-serif|monospace|system-ui|ui-sans-serif|ui-serif|ui-monospace|cursive|fantasy)$/i;
  if (generic.test(name) || name.startsWith("-")) return name;
  return /\s/.test(name) ? `"${name}"` : name;
}

function splitFontFamily(value: string | undefined): string[] {
  if (!value || isUnsafeDesignMdStyleValue(value)) return [];
  return value.split(",").map(normalizeFontName).filter((font): font is string => !!font);
}

function uniqFonts(fonts: string[]): string[] {
  const seen = new Set<string>();
  return fonts.filter((font) => {
    const key = stripQuotes(font).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resolveGeneratedFontFamily(value: string | undefined, context = ""): string {
  const source = [value ?? "", context].join(" ").toLowerCase();
  const original = splitFontFamily(value);
  let fallback: string[] = [];

  if (/sf pro|san francisco|apple system|-apple-system/.test(source)) {
    fallback = ["-apple-system", "BlinkMacSystemFont", "\"SF Pro Display\"", "\"SF Pro Text\"", "system-ui", "sans-serif"];
  } else if (/airbnb cereal|circular/.test(source)) {
    fallback = ["\"Airbnb Cereal VF\"", "Circular", "\"Avenir Next\"", "\"Helvetica Neue\"", "Arial", "sans-serif"];
  } else if (/salesforce avant garde|salesforce sans/.test(source)) {
    fallback = ["\"Salesforce Sans\"", "\"Avenir Next\"", "Inter", "\"Helvetica Neue\"", "Arial", "sans-serif"];
  } else if (/geist/.test(source)) {
    fallback = ["Geist", "Inter", "system-ui", "sans-serif"];
  } else if (/ibm plex/.test(source)) {
    fallback = ["\"IBM Plex Sans\"", "Inter", "system-ui", "sans-serif"];
  } else if (/\binter\b/.test(source)) {
    fallback = ["Inter", "system-ui", "sans-serif"];
  } else if (/helvetica neue|helvetica|neue haas|haas grotesk|haas display/.test(source)) {
    fallback = ["\"Helvetica Neue\"", "Arial", "sans-serif"];
  } else if (/gt america|gt walsheim|gt/.test(source)) {
    fallback = ["\"Helvetica Neue\"", "Inter", "Arial", "system-ui", "sans-serif"];
  } else if (/montserrat/.test(source)) {
    fallback = ["Montserrat", "Inter", "system-ui", "sans-serif"];
  } else if (/roboto/.test(source)) {
    fallback = ["Roboto", "Inter", "system-ui", "sans-serif"];
  } else if (/lato/.test(source)) {
    fallback = ["Lato", "Inter", "system-ui", "sans-serif"];
  } else if (/poppins/.test(source)) {
    fallback = ["Poppins", "Inter", "system-ui", "sans-serif"];
  } else if (/national|nationale|national-.+font/.test(source)) {
    fallback = ["\"Helvetica Neue\"", "Inter", "Arial", "system-ui", "sans-serif"];
  } else if (/ll circular|soehne|untitled sans|graphik/.test(source)) {
    fallback = ["\"Helvetica Neue\"", "Inter", "Arial", "system-ui", "sans-serif"];
  } else if (/mono|monospace|code|terminal|console|sf mono|jetbrains|fira code|source code/.test(source)) {
    fallback = ["\"SF Mono\"", "\"JetBrains Mono\"", "Menlo", "Monaco", "Consolas", "monospace"];
  } else if (/serif|editorial|magazine|publication|luxury|fashion|playfair|garamond|georgia/.test(source)) {
    fallback = ["Georgia", "\"Times New Roman\"", "serif"];
  } else {
    fallback = ["Inter", "-apple-system", "BlinkMacSystemFont", "\"Segoe UI\"", "system-ui", "sans-serif"];
  }

  // If font substitutes are available, insert them between original names and fallback
  if (context.length > 0) {
    const substituteMatch = context.match(/font substitutes?:?\s*([^#]{0,400})/i);
    if (substituteMatch) {
      const substitute = substituteMatch[1]
        .replace(/use\s+/gi, "")
        .replace(/as\s+(a\s+)?(local\s+)?substitute/gi, "")
        .replace(/prefer\s+/gi, "")
        .trim();
      const substituteFonts = substitute
        .split(/[,;\n]/)
        .map((s) => normalizeFontName(s.trim()))
        .filter((f): f is string => !!f && !/(?:substitute|use|local|system|default|fallback|available|proprietary)/i.test(f));
      if (substituteFonts.length > 0 && !substituteFonts[0]?.startsWith("-")) {
        fallback = [...substituteFonts, ...fallback];
      }
    }
  }

  return uniqFonts([...original, ...fallback]).join(", ");
}

function safeTextStyleValue(value: string | undefined): string | undefined {
  if (!value || isUnsafeDesignMdStyleValue(value)) return undefined;
  return value.trim();
}

function getFrontmatterBody(content: string): string {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return content;
  const afterOpen = trimmed.slice(3);
  const closing = afterOpen.match(/\n---\s*(\n|$)/);
  if (!closing || closing.index === undefined) return "";
  return afterOpen.slice(closing.index + closing[0].length);
}

function extractSection(body: string, heading: string): string | null {
  const re = new RegExp(`^#{1,3}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:?\\s*$`, "im");
  const match = body.match(re);
  if (!match || match.index === undefined) return null;
  const after = body.slice(match.index + match[0].length);
  const nextHeading = after.match(/\n#{1,3}\s/);
  const section = nextHeading && nextHeading.index !== undefined ? after.slice(0, nextHeading.index).trim() : after.trim();
  return section || null;
}

function extractFontSubstitutes(body: string): string {
  for (const heading of ["Font Substitutes", "Font Substitute", "Note on Font Substitutes", "Font Notes"]) {
    const section = extractSection(body, heading);
    if (section) return section;
  }
  return "";
}

function extractListItems(body: string, heading: string): string[] {
  const section = extractSection(body, heading);
  if (!section) return [];
  return section
    .split(/\s+-\s+/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean)
    .slice(0, 10);
}

function cleanPhrase(text: string): string {
  return text
    .replace(/\{([^}]+)\}/g, "$1")
    .replace(/[`*_>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPhrases(body: string, description: string): string[] {
  const phrases: string[] = [];
  if (description) phrases.push(cleanPhrase(description));

  for (const heading of SECTION_HEADINGS) {
    const section = extractSection(body, heading);
    if (!section) continue;
    const candidates = section
      .split(/(?<=[.!?])\s+|;\s+|\s+-\s+/)
      .map(cleanPhrase)
      .filter((phrase) => phrase.length > 24);
    phrases.push(...candidates);
  }

  const seen = new Set<string>();
  return phrases
    .filter((phrase) => {
      const key = phrase.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function keywordMatches(text: string): string[] {
  const t = text.toLowerCase();
  const keywords = [
    ["photography-first", /photography|photo-first|product photography|product render/],
    ["marketplace", /marketplace|property|listing|guest|booking|homes|experiences|mobility|ride/],
    ["dashboard", /dashboard|trading|finance|financial platform|markets table|balance|deposit|buy crypto/],
    ["editorial", /editorial|magazine|publication|story|article|news|journalism|media/],
    ["dark", /dark|near-black|black canvas|dark theme|dark mode/],
    ["luxury", /luxury|automotive|vehicle|model|gallery|museum|premium|corporate-automotive/],
    ["utility", /utility|configuration|configurator|workflow|tool|command/],
    ["product tile", /product tile|product-tile|tile sections|tile/],
    ["search", /search|search bar|search-input/],
    ["frosted", /frosted|blur|backdrop/],
    ["pill", /pill|capsule|rounded\.pill|rounded\.full/],
    ["card grid", /card grid|cards|grid|4-up|5-up/],
    ["developer", /docs|developer|code|api|terminal|command|cli/],
    ["data", /data product|chart|analytics|metrics|database|query/],
    ["commerce", /commerce|retail|product card|campaign|pricing|sale/],
    ["music", /music|playlist|album|player|listening|podcast|audio|track/],
    ["ai product", /ai product|ai agent|ai platform|machine learning|artificial intelligence|llm|language model|prompt/],
    ["creative", /creative tool|web design|visual development|no-code|canvas|design tool|builder/],
    ["payment", /payment|card network|transaction|spend|banking|financial services|credit card/],
    ["telecom", /telecom|mobile network|service provider|broadband|connectivity|carrier/],
  ] as const;
  return keywords.filter(([, re]) => re.test(t)).map(([keyword]) => keyword);
}

function paletteGroupFor(key: string): DesignMdPaletteGroupName {
  const k = key.toLowerCase();
  if (/(primary|brand|accent|blue|yellow|rausch|luxe|plus|m-red|m-blue)/.test(k)) return "brand/accent";
  if (/(canvas|surface|background|card|tile|black|white|parchment|elevated)/.test(k)) return "canvas/surface";
  if (/(text|ink|body|foreground|on-primary|on-dark)/.test(k)) return "text/ink";
  if (/(muted|disabled|soft|secondary)/.test(k)) return "muted";
  if (/(border|hairline|divider|stroke|line)/.test(k)) return "borders/hairlines";
  if (/(success|warning|error|danger|info|trading|up|down|status)/.test(k)) return "semantic/status";
  return "brand/accent";
}

function tokensForPrefix(fm: Map<string, string>, prefix: string): DesignMdToken[] {
  const dot = `${prefix}.`;
  const tokens: DesignMdToken[] = [];
  for (const [key, rawValue] of fm) {
    if (!key.startsWith(dot)) continue;
    tokens.push({
      key: key.slice(dot.length),
      rawValue,
      resolvedValue: resolveTokenRef(rawValue, fm),
    });
  }
  return tokens;
}

function buildPalette(fm: Map<string, string>): DesignMdPaletteGroup[] {
  const groups = new Map<DesignMdPaletteGroupName, DesignMdColorToken[]>();
  for (const name of PALETTE_GROUPS) groups.set(name, []);

  for (const token of tokensForPrefix(fm, "colors")) {
    const group = paletteGroupFor(token.key);
    groups.get(group)!.push({ ...token, group });
  }

  return PALETTE_GROUPS.map((name) => ({ name, tokens: groups.get(name)! })).filter((group) => group.tokens.length > 0);
}

function buildMarkdownPalette(body: string): DesignMdPaletteGroup[] {
  const groups = new Map<DesignMdPaletteGroupName, DesignMdColorToken[]>();
  for (const name of PALETTE_GROUPS) groups.set(name, []);

  const seen = new Set<string>();
  const addToken = (labelText: string, value: string) => {
    if (!isSafeColorValue(value) || seen.has(value.toLowerCase())) return;
    seen.add(value.toLowerCase());
    const label = cleanPhrase(labelText || `color-${seen.size}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 42) || `color-${seen.size}`;
    const token: DesignMdColorToken = {
      key: label,
      rawValue: value,
      resolvedValue: value,
      group: paletteGroupFor(label),
    };
    groups.get(token.group)!.push(token);
  };

  for (const line of body.split("\n")) {
    const value = line.match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))/)?.[1];
    if (!value) continue;
    const label = line.match(/\*\*([^*\n]+)\*\*/)?.[1]
      ?? line.match(/--([a-z0-9-]+)/i)?.[1]
      ?? line.match(/^\s*[-*]\s*([^(:`]+?)\s*(?:\(|`|:)/)?.[1]
      ?? "";
    addToken(label, value);
    if (seen.size >= 28) break;
  }

  const matches = body.matchAll(/(?:\*\*([^*\n]+)\*\*|`([^`\n]+)`|--([a-z0-9-]+))?[^#\n]{0,80}(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))/g);
  for (const match of matches) {
    const value = match[4];
    addToken(match[1] || match[2] || match[3] || `color-${seen.size + 1}`, value);
    if (seen.size >= 28) break;
  }

  return PALETTE_GROUPS.map((name) => ({ name, tokens: groups.get(name)! })).filter((group) => group.tokens.length > 0);
}

function typographyBaseNames(fm: Map<string, string>): string[] {
  const names = new Set<string>();
  for (const key of fm.keys()) {
    if (!key.startsWith("typography.")) continue;
    const rest = key.slice("typography.".length);
    const parts = rest.split(".");
    names.add(parts.length > 1 ? parts.slice(0, -1).join(".") : rest);
  }
  return Array.from(names).filter(Boolean);
}

function buildTypography(fm: Map<string, string>): DesignMdTypographyToken[] {
  return typographyBaseNames(fm).map((name) => {
    const raw: Record<string, string> = {};
    const prefix = `typography.${name}.`;
    for (const [key, value] of fm) {
      if (key.startsWith(prefix)) raw[key.slice(prefix.length)] = resolveTokenRef(value, fm);
    }
    const pick = (...keys: string[]) => keys.map((key) => raw[key]).find(Boolean);
    return {
      key: name,
      fontFamily: isSafeFontFamilyValue(pick("fontFamily", "font-family")) ? pick("fontFamily", "font-family") : undefined,
      fontSize: isSafeSizeValue(pick("fontSize", "font-size")) ? pick("fontSize", "font-size") : undefined,
      fontWeight: safeTextStyleValue(pick("fontWeight", "font-weight")),
      lineHeight: safeTextStyleValue(pick("lineHeight", "line-height")),
      letterSpacing: safeTextStyleValue(pick("letterSpacing", "letter-spacing")),
      raw,
    };
  });
}

function componentKind(name: string): DesignMdComponentKind {
  const n = name.toLowerCase();
  if (/gradient|mesh/.test(n)) return "gradient";
  if (/mockup|code-window|code block|code-block|code panel|code-panel/.test(n)) return "code-panel";
  if (/terminal|console|shell/.test(n)) return "terminal-panel";
  if (/hero|band/.test(n)) return "hero";
  if (/chart|graph|sparkline|bar/.test(n)) return "chart";
  if (/market.*table|markets.*table|asset.*table|price.*table/.test(n)) return "market-table";
  if (/table|row|cell/.test(n)) return "table";
  if (/pricing/.test(n)) return "pricing-card";
  if (/stat|metric|balance/.test(n)) return "stat-card";
  if (/stat|metric|balance/.test(n)) return "stat";
  if (/product.*tile|tile.*product/.test(n)) return "product-tile";
  if (/workflow.*step|step.*card|workflow|automation|pipeline/.test(n)) return "workflow-step";
  if (/prompt.*input|ai.*input|model.*input/.test(n)) return "prompt-input";
  if (/search/.test(n)) return "search";
  if (/button|cta/.test(n)) return "button";
  if (/input|field|amount/.test(n)) return "input";
  if (/sub-nav|subnav|sticky/.test(n)) return "subnav";
  if (/nav|header/.test(n)) return "nav";
  if (/link/.test(n)) return "link";
  if (/quote/.test(n)) return "quote";
  if (/footer|legal/.test(n)) return "footer";
  if (/badge/.test(n)) return "badge";
  if (/chip|tag|pill/.test(n)) return "chip";
  if (/editorial.*card|article.*card|story.*card|news.*card/.test(n)) return "editorial-card";
  if (/media.*card|image.*card|photo.*card/.test(n)) return "media-card";
  if (/payment.*card|transaction.*card|payment.*tile/.test(n)) return "payment-card";
  if (/tile/.test(n)) return "tile";
  if (/card|panel|callout/.test(n)) return "card";
  if (/utility|option|configurator|filter/.test(n)) return "utility";
  return "generic";
}

function safeStyleProp(prop: string, value: string): string | undefined {
  const p = prop.toLowerCase();
  if (isUnsafeDesignMdStyleValue(value)) return undefined;
  if (/(background|color|bordercolor|border-color)/.test(p)) return isSafeColorValue(value) ? value.trim() : undefined;
  if (/(rounded|borderradius|border-radius|height|width|size)/.test(p)) return isSafeSizeValue(value) ? value.trim() : undefined;
  if (/padding|margin|gap/.test(p)) return isSafeSpacingValue(value) ? value.trim() : undefined;
  if (/typography/.test(p)) return value.trim();
  return undefined;
}

function buildComponents(fm: Map<string, string>): DesignMdComponentGroup[] {
  const groups = new Map<string, DesignMdComponentGroup>();
  for (const token of tokensForPrefix(fm, "components")) {
    const [name, ...propParts] = token.key.split(".");
    if (!name || propParts.length === 0) continue;
    const firstProp = propParts[0];
    const propLooksLikeStyle = /^(background|backgroundColor|background-color|color|textColor|text-color|border|borderColor|border-color|rounded|borderRadius|border-radius|padding|margin|gap|height|width|size)$/i.test(firstProp);
    const nestedComponent = propParts.length > 1 && !propLooksLikeStyle;
    const groupName = nestedComponent ? `${name}-${firstProp}` : name;
    const prop = (nestedComponent ? propParts.slice(1) : propParts).join(".");
    if (!groups.has(groupName)) groups.set(groupName, { name: groupName, kind: componentKind(groupName), raw: {}, styles: {} });
    const group = groups.get(groupName)!;
    group.raw[prop] = token.resolvedValue;
    const safe = safeStyleProp(prop, token.resolvedValue);
    if (safe) group.styles[prop] = safe;
  }
  return Array.from(groups.values());
}

function buildMarkdownComponents(body: string): DesignMdComponentGroup[] {
  const names = new Set<string>();
  const patterns = [
    /\b(search(?:\s+bar|\s+input)?)\b/ig,
    /\b((?:pricing|feature|stat|metric|product|market|model|code|terminal|hero|photo|workflow|dashboard|property|listing|album|playlist|campaign|trust|logo|pipeline)\s+(?:card|cards|tile|tiles|panel|panels|table|tables|row|rows|band|bands|mockup|mockups|block|blocks|grid|bar))\b/ig,
    /\b((?:pill|status|workflow|guest-favorite)\s+badge)\b/ig,
    /\b((?:top|sub|global)\s+nav)\b/ig,
    /\b((?:primary|secondary|outline|pill)\s+button)\b/ig,
    /\b((?:market|metrics?|asset|track|playlist)\s+table)\b/ig,
    /\b((?:bar|line|price|usage|analytics?)\s+chart)\b/ig,
    /\b((?:code|terminal|console)\s+(?:block|window|panel))\b/ig,
    /\b((?:workflow|deployment)\s+pipeline)\b/ig,
    /\b((?:now-playing|playback|player)\s+bar)\b/ig,
  ];
  for (const re of patterns) {
    for (const match of body.matchAll(re)) {
      const name = cleanPhrase(match[1])
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      if (name) names.add(name);
      if (names.size >= 18) break;
    }
  }
  return Array.from(names).map((name) => ({
    name,
    kind: componentKind(name),
    raw: {},
    styles: {},
  }));
}

function inferArchetype(slug: string, phrases: string[], keywords: string[], componentNames: string[]): DesignMdArchetype {
  const text = [slug, ...phrases, ...keywords, ...componentNames].join(" ").toLowerCase();
  const score = (patterns: RegExp[]) => patterns.reduce((sum, re) => sum + (re.test(text) ? 1 : 0), 0);
  const scores: Record<DesignMdArchetype, number> = {
    marketplace: score([/marketplace/, /property/, /listing/, /guest/, /booking/, /search-bar/, /homes/, /ride/, /mobility/, /uber/]),
    product_gallery: score([/photography-first/, /product tile/, /product-tile/, /sparse/, /museum/, /apple/]),
    finance_dashboard: score([/trading/, /markets/, /crypto/, /balance/, /deposit/, /asset-row/, /coinbase|binance/]),
    developer_docs: score([/docs/, /api/, /code-window/, /cli/, /infrastructure/, /supabase/]),
    luxury_automotive: score([/automotive/, /vehicle/, /model-card/, /inventory-card/, /bmw|bugatti|ferrari|lamborghini|tesla/, /luxury/, /performance/]),
    data_product: score([/data product/, /analytics/, /database/, /query/, /metrics/, /clickhouse|cohere|sanity/]),
    collaboration_saas: score([/messaging/, /workplace/, /collaboration/, /aubergine/, /pastel-mesh/, /slack|slacc/]),
    editorial: score([/editorial/, /magazine/, /story/, /article/, /publication/, /news/, /journalism/, /theverge|wired/]),
    ai_product: score([/ai/, /artificial intelligence/, /model/, /prompt/, /agent/, /ai product/, /ai agent/, /generated/, /runway|together\.ai|voltagent|lovable|x\.ai/]),
    creative_tool: score([/creative tool/, /no-code/, /visual development/, /design tool/, /canvas/, /web design/, /webflow|framer/]),
    payment_finance: score([/payment/, /card network/, /financial/, /spend/, /transaction/, /mastercard|wise/]),
    music_campaign: score([/music/, /playlist/, /album/, /player/, /listening/, /podcast/, /spotify/, /audio/]),
    terminal_tool: score([/terminal/, /command line/, /warp/, /shell/, /developer tool/]),
    generic_system: 0,
  };

  // Slug-specific hints as tiebreakers — used only to boost, never to override zero scores
  const slugLower = slug.toLowerCase();
  if (/(slack|slacc)/.test(text)) scores.collaboration_saas += 4;
  if (/(supabase|vercel|opencode)/.test(text)) scores.developer_docs += 4;
  if (/(runwayml|runway)/.test(slugLower) && scores.ai_product > 0) scores.ai_product += 4;
  if (/(together\.ai|together\.dev)/.test(slugLower) && scores.ai_product > 0) scores.ai_product += 4;
  if (/(voltagent)/.test(slugLower) && scores.ai_product > 0) scores.ai_product += 4;
  if (/(lovable)/.test(slugLower) && scores.ai_product > 0) scores.ai_product += 3;
  if (/(x\.ai)/.test(slugLower) && scores.ai_product > 0) scores.ai_product += 3;
  if (/(webflow)/.test(slugLower) && scores.creative_tool > 0) scores.creative_tool += 4;
  if (/(warp)/.test(slugLower) && scores.terminal_tool > 0) scores.terminal_tool += 4;
  if (/(spotify)/.test(slugLower) && scores.music_campaign > 0) scores.music_campaign += 4;
  if (/(mastercard)/.test(slugLower) && scores.payment_finance > 0) scores.payment_finance += 4;
  if (/(wise)/.test(slugLower) && scores.payment_finance > 0) scores.payment_finance += 3;
  if (/(theverge|wired)/.test(slugLower) && scores.editorial > 0) scores.editorial += 4;
  if (/(starbucks)/.test(slugLower) && scores.editorial > 0) scores.editorial += 3;
  if (/(uber)/.test(slugLower) && scores.marketplace > 0) scores.marketplace += 3;
  if (/(vodafone)/.test(slugLower) && scores.marketplace > 0) scores.marketplace += 2;
  if (/(zapier)/.test(slugLower) && scores.data_product > 0) scores.data_product += 3;
  if (/(kraken)/.test(slugLower) && scores.finance_dashboard > 0) scores.finance_dashboard += 4;
  if (/(clickhouse|cohere|mongodb|posthog)/.test(slugLower)) scores.data_product += 5;
  if (/(binance|coinbase|kraken|revolut)/.test(text) && scores.finance_dashboard > 0) scores.finance_dashboard += 3;
  if (/(bmw|bugatti|ferrari|lamborghini|tesla)/.test(slugLower) && scores.luxury_automotive > 0) scores.luxury_automotive += 3;
  if (/(nike|shopify|pinterest)/.test(slugLower) && scores.editorial > 0) scores.editorial += 3;
  if (/(sanity)/.test(slugLower) && scores.data_product > 0) scores.data_product += 3;

  // Boost payment_finance for finance slugs that don't look like trading platforms
  if (/mastercard|wise|stripe|visa|paypal/.test(slugLower) && scores.payment_finance > 0) {
    scores.payment_finance += 3;
  }

  // If text mentions music/campaign and slug is spotify, prefer music_campaign over editorial
  if (/(spotify)/.test(slugLower)) {
    if (scores.music_campaign > 0) scores.music_campaign += 5;
  }

  // If text mentions AI heavily but also matches developer_docs, prefer ai_product
  if (scores.ai_product >= 3 && scores.developer_docs > 0) scores.ai_product += 2;

  const ordered = Object.entries(scores).sort((a, b) => b[1] - a[1]) as [DesignMdArchetype, number][];
  return ordered[0][1] > 0 ? ordered[0][0] : "generic_system";
}

export function parseDesignMdForPreview(
  slug: string,
  title: string,
  description: string,
  content: string,
): DesignMdPreviewModel {
  const fm = parseNestedFrontmatter(content);
  const body = getFrontmatterBody(content);
  const phrases = extractPhrases(body, description);
  const keywords = Array.from(new Set(keywordMatches([description, ...phrases].join(" "))));
  const components = buildComponents(fm);
  const palette = buildPalette(fm);

  return {
    meta: { slug, title, description },
    palette: palette.length > 0 ? palette : buildMarkdownPalette(body || content),
    typography: buildTypography(fm),
    radius: tokensForPrefix(fm, "rounded").concat(tokensForPrefix(fm, "radius")),
    spacing: tokensForPrefix(fm, "spacing"),
    components: components.length > 0 ? components : buildMarkdownComponents(body || content),
    visualLanguage: { phrases, keywords },
    archetype: inferArchetype(slug, phrases, keywords, components.map((component) => component.name)),
    overviewText: extractSection(body, "Overview"),
    layoutText: extractSection(body, "Layout"),
    fontSubstitutes: extractFontSubstitutes(body),
    guardrailDos: extractListItems(body, "Do"),
    guardrailDonts: extractListItems(body, "Don't"),
  };
}

export function safeColorStyle(val: string): Record<string, string> | null {
  return isSafeColorValue(val) ? { backgroundColor: val } : null;
}

export function safeTypoStyle(
  fontSize: string | undefined,
  fontWeight: string | undefined,
  lineHeight: string | undefined,
  fontFamily: string | undefined,
): Record<string, string> {
  const style: Record<string, string> = {};
  if (isSafeSizeValue(fontSize)) style.fontSize = fontSize;
  if (fontWeight && /^(?:\d{3}|bold|normal|lighter|bolder)$/.test(fontWeight)) style.fontWeight = fontWeight;
  if (lineHeight && !isUnsafeDesignMdStyleValue(lineHeight)) style.lineHeight = lineHeight;
  if (isSafeFontFamilyValue(fontFamily)) style.fontFamily = fontFamily;
  return style;
}

export function safeButtonStyle(fm: Map<string, string>): Record<string, string> {
  const style: Record<string, string> = {};
  const bg = resolveTokenRef(fm.get("components.button-primary.backgroundColor") ?? "", fm);
  const color = resolveTokenRef(fm.get("components.button-primary.textColor") ?? "", fm);
  const radius = resolveTokenRef(fm.get("components.button-primary.rounded") ?? "", fm);
  if (isSafeColorValue(bg)) { style.backgroundColor = bg; style.borderColor = bg; }
  if (isSafeColorValue(color)) style.color = color;
  if (isSafeSizeValue(radius)) style.borderRadius = radius;
  return style;
}

export function safeCardStyle(fm: Map<string, string>): Record<string, string> {
  const style: Record<string, string> = {};
  const bg = resolveTokenRef(fm.get("components.card.backgroundColor") ?? fm.get("components.card.background") ?? "", fm);
  const radius = resolveTokenRef(fm.get("components.card.borderRadius") ?? fm.get("components.card.rounded") ?? "", fm);
  if (isSafeColorValue(bg)) style.backgroundColor = bg;
  if (isSafeSizeValue(radius)) style.borderRadius = radius;
  return style;
}
