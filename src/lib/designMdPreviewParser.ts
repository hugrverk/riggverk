import { sourceEvidence } from "./designMdSourceEvidence";
import {
  inferColorSemantics,
  type ColorSemanticRole,
  type ColorUsageIntensity,
  type ColorUsageScope,
} from "./designMdColorSemantics";

export type DesignMdArchetype =
  | "product_gallery"
  | "marketplace"
  | "finance_dashboard"
  | "editorial"
  | "media_editorial"
  | "collaboration_saas"
  | "developer_docs"
  | "developer_product"
  | "luxury_automotive"
  | "data_product"
  | "ai_product"
  | "ai_agent_product"
  | "creative_tool"
  | "payment_finance"
  | "retail_food"
  | "retail_brand"
  | "telecom_service"
  | "automation_workflow"
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

export type DesignMdSourceType =
  | "frontmatter"
  | "markdown-heading"
  | "markdown-table"
  | "markdown-list"
  | "markdown-paragraph"
  | "derived-fallback";

export type DesignMdSourceConfidence = "high" | "medium" | "low" | "fallback";

export interface DesignMdSourceEvidence {
  sourceType: DesignMdSourceType;
  sourcePath: string;
  confidence: DesignMdSourceConfidence;
  text?: string;
}

export interface DesignMdToken {
  key: string;
  rawValue: string;
  resolvedValue: string;
  source?: "structured" | "markdown" | "derived";
  sourceEvidence?: DesignMdSourceEvidence;
}

export interface DesignMdColorToken extends DesignMdToken {
  group: DesignMdPaletteGroupName;
  semanticRole?: ColorSemanticRole;
  usageScope?: ColorUsageScope;
  usageIntensity?: ColorUsageIntensity;
  semanticEvidence?: string[];
  semanticWarnings?: string[];
}

export interface DesignMdTypographyToken {
  key: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
  raw: Record<string, string>;
  source?: "structured" | "markdown" | "derived";
  sourceEvidence?: DesignMdSourceEvidence;
}

export interface DesignMdComponentGroup {
  name: string;
  kind: DesignMdComponentKind;
  raw: Record<string, string>;
  styles: Record<string, string>;
  source?: "structured" | "markdown" | "derived";
  sourceEvidence?: DesignMdSourceEvidence;
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
  phraseEvidence?: DesignMdSourceEvidence[];
}

export type DesignMdConfidence = "low" | "medium" | "high";

export type DesignMdPreviewWarning =
  | "no structured colors"
  | "no structured typography"
  | "no structured components"
  | "markdown-derived-only"
  | "dark tokens derived"
  | "generic archetype fallback"
  | "font fallback only"
  | "likely contrast risk";

export interface DesignMdPreviewCoverage {
  colorsCount: number;
  markdownColorsCount: number;
  typographyCount: number;
  radiusCount: number;
  spacingCount: number;
  componentCount: number;
  componentKinds: Partial<Record<DesignMdComponentKind, number>>;
  fontFamilies: string[];
  markdownSections: string[];
  darkTokenCount: number;
  darkComponentCount: number;
  componentGroupsWithEvidenceCount: number;
  fontSubstituteHintsCount: number;
}

export interface DesignMdPreviewConfidence {
  archetype: DesignMdConfidence;
  lightPreview: DesignMdConfidence;
  darkPreview: DesignMdConfidence;
  components: DesignMdConfidence;
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
  archetypeEvidence: DesignMdSourceEvidence;
  coverage: DesignMdPreviewCoverage;
  confidence: DesignMdPreviewConfidence;
  warnings: DesignMdPreviewWarning[];
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
  "Component Stylings",
  "Component Library",
  "Key Components",
  "Shapes",
  "Typography",
  "Typography Rules",
  "Colors",
  "Color Palette",
  "Color Palette & Roles",
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
  } else if (/abcnormal|abc\s*normal/.test(source)) {
    fallback = ["Inter", "DM Sans", "system-ui", "sans-serif"];
  } else if (/spotifymix|spotify\s*mix|circularsp|circular\s*sp/.test(source)) {
    fallback = ["\"Helvetica Neue\"", "Inter", "Arial", "system-ui", "sans-serif"];
  } else if (/universal\s*sans/.test(source)) {
    fallback = ["-apple-system", "BlinkMacSystemFont", "\"Segoe UI\"", "Inter", "Arial", "system-ui", "sans-serif"];
  } else if (/matter\b/.test(source)) {
    fallback = ["Inter", "-apple-system", "BlinkMacSystemFont", "system-ui", "sans-serif"];
  } else if (/degular|gt\s*alpina/.test(source)) {
    fallback = ["Inter", "\"Helvetica Neue\"", "Arial", "system-ui", "sans-serif"];
  } else if (/waldenburg/.test(source)) {
    fallback = ["Inter", "\"Helvetica Neue\"", "Arial", "system-ui", "sans-serif"];
  } else if (/wf\s*visual\s*sans/.test(source)) {
    fallback = ["Inter", "Arial", "system-ui", "sans-serif"];
  } else if (/mono|monospace|code|terminal|console|sf mono|jetbrains|fira code|source code/i.test(source)) {
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSection(body: string, heading: string): string | null {
  const escaped = escapeRegex(heading);
  // Match headings where this keyword appears: "## Overview", "## 1. Overview", "### Colors", etc
  const patterns = [
    new RegExp(`^#{1,3}\\s+${escaped}:?\\s*$`, "im"),
    new RegExp(`^#{1,3}\\s+\\d+\\.?\\s*${escaped}:?\\s*$`, "im"),
    new RegExp(`^#{1,3}\\s+[^#\\n]*\\b${escaped}\\b[^#\\n]*:?\\s*$`, "im"),
  ];
  let match: RegExpMatchArray | null = null;
  for (const re of patterns) {
    match = body.match(re);
    if (match) break;
  }
  // Fallback: bold text like **Key Characteristics:**
  if (!match) {
    match = body.match(new RegExp(`\\*\\*${escaped}:?\\*\\*\\s*\\n?`, "i"));
  }
  if (!match || match.index === undefined) return null;
  const after = body.slice(match.index + match[0].length);
  const nextHeading = after.match(/\n#{1,3}\s|\n\*\*[A-Z][^*]{2,30}\*\*/);
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

function normalizeTokenLabel(text: string, fallback: string): string {
  return cleanPhrase(text || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 52) || fallback;
}

function extractPhrases(body: string, description: string): string[] {
  const phrases: string[] = [];
  if (description) phrases.push(cleanPhrase(description));

  for (const heading of SECTION_HEADINGS) {
    const section = extractSection(body, heading);
    if (!section) continue;
    const candidates = section
      .split(/(?<=[.!?])\s+|;\s+|\s+-\s+|\n[-*]\s+/)
      .map(cleanPhrase)
      .filter((phrase) => phrase.length > 16 && phrase.length < 220);
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
    ["dark", /dark|near-black|black canvas|dark theme|dark mode|night|inverse|on-dark|on-black|charcoal|slate|terminal|code panel|cinematic|aubergine/],
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
    ["food", /coffee|beverage|cafe|menu|drink|restaurant|food/],
    ["automation", /automation|workflow|zap|pipeline|integration|trigger|connect app/],
  ] as const;
  return keywords.filter(([, re]) => re.test(t)).map(([keyword]) => keyword);
}

function paletteGroupFor(key: string): DesignMdPaletteGroupName {
  const k = key.toLowerCase();
  // Primary/brand/accent colors
  if (/(primary|brand|accent|blue|yellow|rausch|luxe|plus|m-red|m-blue)/.test(k)) return "brand/accent";
  // Text/ink colors — check before canvas/surface so ink-black stays in text/ink
  if (/(text|ink|body|foreground|on-primary|on-dark)/.test(k)) return "text/ink";
  // Muted/disabled/soft/secondary
  if (/(muted|disabled|soft|secondary)/.test(k)) return "muted";
  // Borders/hairlines
  if (/(border|hairline|divider|stroke|line)/.test(k)) return "borders/hairlines";
  // Semantic/status
  if (/(success|warning|error|danger|info|trading|up|down|status)/.test(k)) return "semantic/status";
  // Canvas/surface — only black/white when not already caught by text/ink
  if (/(canvas|surface|background|card|tile|black|white|parchment|elevated)/.test(k)) return "canvas/surface";
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
      source: "structured",
      sourceEvidence: sourceEvidence("frontmatter", `${prefix}.${key.slice(dot.length)}`, "high", rawValue),
    });
  }
  return tokens;
}

function attachColorSemantics(token: DesignMdColorToken, prose: string): DesignMdColorToken {
  const semantics = inferColorSemantics({
    key: token.key,
    value: token.resolvedValue,
    group: token.group,
    prose,
    sourceEvidence: token.sourceEvidence,
  });
  return {
    ...token,
    semanticRole: semantics.semanticRole,
    usageScope: semantics.usageScope,
    usageIntensity: semantics.usageIntensity,
    semanticEvidence: semantics.evidence,
    semanticWarnings: semantics.warnings,
  };
}

function buildPalette(fm: Map<string, string>, prose = ""): DesignMdPaletteGroup[] {
  const groups = new Map<DesignMdPaletteGroupName, DesignMdColorToken[]>();
  for (const name of PALETTE_GROUPS) groups.set(name, []);

  for (const token of tokensForPrefix(fm, "colors")) {
    const group = paletteGroupFor(token.key);
    groups.get(group)!.push(attachColorSemantics({ ...token, group }, prose));
  }

  return PALETTE_GROUPS.map((name) => ({ name, tokens: groups.get(name)! })).filter((group) => group.tokens.length > 0);
}

function buildMarkdownPalette(body: string, prose = body): DesignMdPaletteGroup[] {
  const groups = new Map<DesignMdPaletteGroupName, DesignMdColorToken[]>();
  for (const name of PALETTE_GROUPS) groups.set(name, []);

  const seen = new Set<string>();
  const addToken = (labelText: string, value: string, evidenceType: DesignMdSourceType) => {
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
      source: "markdown",
      sourceEvidence: sourceEvidence(evidenceType, `markdown.Colors.${label}`, evidenceType === "markdown-table" ? "medium" : "low", `${labelText} ${value}`),
    };
    groups.get(token.group)!.push(attachColorSemantics(token, prose));
  };

  for (const line of body.split("\n")) {
    const value = line.match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))/)?.[1];
    if (!value) continue;
    const tableCells = line.trim().startsWith("|") ? line.split("|").map((cell) => cell.trim()).filter(Boolean) : [];
    const label = line.match(/\*\*([^*\n]+)\*\*/)?.[1]
      ?? line.match(/--([a-z0-9-]+)/i)?.[1]
      ?? line.match(/`([^`\n]*color[^`\n]*)`/i)?.[1]
      ?? tableCells.find((cell) => !/(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/i.test(cell))
      ?? line.match(/^\s*[-*]\s*([^(:`]+?)\s*(?:\(|`|:)/)?.[1]
      ?? "";
    addToken(label, value, tableCells.length > 0 ? "markdown-table" : line.trim().startsWith("-") || line.trim().startsWith("*") ? "markdown-list" : "markdown-paragraph");
    if (seen.size >= 28) break;
  }

  const matches = body.matchAll(/(?:\*\*([^*\n]+)\*\*|`([^`\n]+)`|--([a-z0-9-]+))?[^#\n]{0,80}(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))/g);
  for (const match of matches) {
    const value = match[4];
    addToken(match[1] || match[2] || match[3] || `color-${seen.size + 1}`, value, "markdown-paragraph");
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
      source: "structured",
      sourceEvidence: sourceEvidence("frontmatter", `typography.${name}`, "high", Object.entries(raw).map(([key, value]) => `${key}: ${value}`).join("; ")),
    };
  });
}

function extractFontFromMarkdown(body: string): string | undefined {
  // Match font family declarations in markdown: "Font: `abcNormal`", "Font Family: abcNormal", "**Universal**: \`abcNormal\`"
  const patterns = [
    /\*\*Universal\*\*:\s*(?:`([^`]+)`|([^\n,.]+))/i,
    /\*\*Display\*\*:\s*(?:`([^`]+)`|([^\n,;]+))/i,
    /\*\*Title\*\*:\s*(?:`([^`]+)`|([^\n,;]+))/i,
    /\*\*UI\s*\/?\s*Body\*\*:\s*(?:`([^`]+)`|([^\n,;]+))/i,
    /Font(?:\s*Family)?:?\s*(?:`([^`]+)`|([^\n,.]+))/i,
    /###\s*Font\s*Famil(?:y|ies)\s*\n+\s*(?:-|•|\*)?\s*(?:`([^`]+)`|([^\n,;]+))/i,
    /###\s*Font\s*(?:Family|Families)\s*\n(?:.|\n)*?\*\*[\w\s]+\*\*:\s*(?:`([^`]+)`|([^\n,;]+))/i,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m) {
      const font = (m[1] || m[2] || "").trim()
        .replace(/fallback\s*:\s*.+/i, "")
        .replace(/with\s+fallback.+/i, "")
        .replace(/,?\s*-apple-system.*$/i, "")
        .trim();
      const wordCount = font.split(/\s+/).filter(Boolean).length;
      const proseLike = /\b(?:is|are|the|a|an|and|or|creates|create|confident|crown|jewel|design|system|typography|fallback|substitute|use|local|available)\b/i.test(font);
      if (font && font.length > 0 && font.length < 80 && wordCount <= 4 && !proseLike && !/^(?:serif|sans-serif|monospace|system-ui|[A-Z][a-z]+ Sans)$/i.test(font)) {
        return font;
      }
    }
  }
  return undefined;
}

function parseMarkdownTypeTable(body: string): DesignMdTypographyToken[] {
  // Find typography tables (Role/Token/Name | Size | Weight | Line Height | ...)
  const headerRe = /\|\s*(?:Role|Token|Name|Style|Type)\s*\|\s*(?:Font\s*\|)?\s*Size\s*\|[\s\w|/-]*Weight[\s\w|/-]*/i;
  const headerMatch = body.match(headerRe);
  if (!headerMatch || headerMatch.index === undefined) return [];

  const afterHeader = body.slice(headerMatch.index);
  // Skip header + separator line
  const rows = afterHeader.split("\n").slice(2);
  const tokens: DesignMdTypographyToken[] = [];

  for (const row of rows) {
    if (!row.trim().startsWith("|")) break;
    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 3) continue;

    // First cell is role/name, rest are values
    const name = cleanPhrase(cells[0] || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+(?:[a-z0-9]+)?/g, (m) => m.length > 1 ? "-" : "")
      .replace(/^-|-$/g, "")
      .slice(0, 30) || `type-${tokens.length + 1}`;

    // Parse size from cell that looks like "48px" or "48px (3rem)"
    let fontSize: string | undefined;
    let fontWeight: string | undefined;
    let lineHeight: string | undefined;
    let letterSpacing: string | undefined;

    for (const cell of cells.slice(1)) {
      const sizeMatch = cell.match(/(\d+(?:\.\d+)?)\s*(?:px|rem|em)/);
      if (sizeMatch && !fontSize) {
        fontSize = sizeMatch[0];
      }
      const weightMatch = cell.match(/\b(\d{3}|bold|normal|regular|lighter|bolder|medium|semibold)\b/i);
      if (weightMatch && !fontWeight) {
        const w = weightMatch[1].toLowerCase();
        const weightMap: Record<string, string> = { regular: "400", medium: "500", semibold: "600", bold: "700", normal: "400" };
        fontWeight = weightMap[w] ?? w;
      }
      const lhMatch = cell.match(/(\d+(?:\.\d+))\s*(?:\(tight\))?/);
      if (lhMatch && lhMatch[1] && !lineHeight && Number.parseFloat(lhMatch[1]) < 3) {
        lineHeight = lhMatch[1];
      }
      const lsMatch = cell.match(/(-?\d+(?:\.\d+))\s*(?:px)?/);
      if (lsMatch && lsMatch[1] && !letterSpacing && Number.parseFloat(lsMatch[1]) <= 5 && Number.parseFloat(lsMatch[1]) >= -10) {
        letterSpacing = lsMatch[0];
      }
    }

    if (fontSize || fontWeight) {
      const raw: Record<string, string> = {};
      if (fontSize) raw["fontSize"] = fontSize;
      if (fontWeight) raw["fontWeight"] = fontWeight;
      if (lineHeight) raw["lineHeight"] = lineHeight;
      if (letterSpacing) raw["letterSpacing"] = letterSpacing;
      tokens.push({
        key: name,
        fontSize,
        fontWeight,
        lineHeight,
        letterSpacing,
        raw,
        source: "markdown",
        sourceEvidence: sourceEvidence("markdown-table", `markdown.Typography.${name}`, "medium", row),
      });
    }
    if (tokens.length >= 12) break;
  }
  return tokens;
}

function buildMarkdownTypography(body: string): DesignMdTypographyToken[] {
  const tokens = parseMarkdownTypeTable(body);
  const fontFamily = extractFontFromMarkdown(body);
  if (tokens.length === 0 && fontFamily && isSafeFontFamilyValue(fontFamily)) {
    return [
      {
        key: "display",
        fontFamily,
        fontSize: "40px",
        fontWeight: "700",
        lineHeight: "1.05",
        raw: { fontFamily },
        source: "markdown",
        sourceEvidence: sourceEvidence("markdown-paragraph", "markdown.Fonts.display", "low", fontFamily),
      },
      {
        key: "body",
        fontFamily,
        fontSize: "16px",
        fontWeight: "400",
        lineHeight: "1.45",
        raw: { fontFamily },
        source: "markdown",
        sourceEvidence: sourceEvidence("markdown-paragraph", "markdown.Fonts.body", "low", fontFamily),
      },
    ];
  }
  if (fontFamily && isSafeFontFamilyValue(fontFamily)) {
    for (const t of tokens) {
      if (!t.fontFamily) t.fontFamily = fontFamily;
    }
  }
  return tokens;
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
    if (!groups.has(groupName)) {
      groups.set(groupName, {
        name: groupName,
        kind: componentKind(groupName),
        raw: {},
        styles: {},
        source: "structured",
        sourceEvidence: sourceEvidence("frontmatter", `components.${groupName}`, "high", token.key),
      });
    }
    const group = groups.get(groupName)!;
    group.raw[prop] = token.resolvedValue;
    const safe = safeStyleProp(prop, token.resolvedValue);
    if (safe) group.styles[prop] = safe;
  }
  return Array.from(groups.values());
}

function buildMarkdownComponents(body: string): DesignMdComponentGroup[] {
  const names = new Set<string>();

  // Extract from markdown sub-headings inside component sections
  const componentSections = [
    /components?\s+stylings?/i,
    /components?\s+library/i,
    /key\s+components/i,
  ];
  for (const sectionRe of componentSections) {
    const sectionMatch = body.match(new RegExp(`^#{1,4}\\s+[^#\\n]*${sectionRe.source}[^#\\n]*$`, "im"));
    if (sectionMatch && sectionMatch.index !== undefined) {
      const after = body.slice(sectionMatch.index + sectionMatch[0].length);
      const nextSection = after.match(/\n#{1,2}\s/);
      const section = nextSection && nextSection.index !== undefined ? after.slice(0, nextSection.index) : after.slice(0, 1000);

      // Extract ### or **Bold** sub-heading names
      const subHeadings = section.matchAll(/(?:^#{3,4}\s+|\*\*)([^*#\n]{2,40})(?:\*\*|\s*$)/gm);
      for (const m of subHeadings) {
        const name = cleanPhrase(m[1])
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        if (name && name.length > 1 && !/^(?:the|and|for|with|from|are|has|not|its)$/.test(name)) {
          names.add(name);
        }
      }
    }
  }

  // Existing patterns for specific component names
  const patterns = [
    /\b(search(?:\s+bar|\s+input)?)\b/ig,
    /\b((?:pricing|feature|stat|metric|product|market|model|code|terminal|hero|photo|workflow|dashboard|property|listing|album|playlist|campaign|trust|logo|pipeline|menu|store|plan|coverage|device)\s+(?:card|cards|tile|tiles|panel|panels|table|tables|row|rows|band|bands|mockup|mockups|block|blocks|grid|bar|module))\b/ig,
    /\b((?:editorial|article|story|news|media|payment|conversion|vehicle|spec|prompt|agent|tool|action)\s+(?:card|cards|tile|tiles|panel|panels|table|tables|row|rows|input|graph|flow|module|widget))\b/ig,
    /\b((?:vehicle|market|payment|conversion|workflow|prompt|terminal|code|editorial|playlist|property|product)\s+(?:spec\s+)?(?:card|table|widget|panel|input|tile))\b/ig,
    /\b((?:pill|status|workflow|guest-favorite)\s+badge)\b/ig,
    /\b((?:top|sub|global|main|side)\s+nav)\b/ig,
    /\b((?:primary|secondary|outline|pill|cta|ghost)\s+button)\b/ig,
    /\b((?:market|metrics?|asset|track|playlist|transaction|spend)\s+table)\b/ig,
    /\b((?:bar|line|price|usage|analytics?)\s+chart)\b/ig,
    /\b((?:code|terminal|console)\s+(?:block|window|panel))\b/ig,
    /\b((?:workflow|deployment|automation)\s+pipeline)\b/ig,
    /\b((?:now-playing|playback|player)\s+bar)\b/ig,
    /\b((?:prompt|ai)\s+input)\b/ig,
    /\b((?:hero|photo)\s+band)\b/ig,
    /\b((?:order|buy|cancel|submit)\s+button)\b/ig,
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

  // Fallback: extract any bold phrases in a Components section as potential component names
  if (names.size < 3) {
    const compSection = extractSection(body, "Components");
    const compSection2 = extractSection(body, "Component Stylings");
    const section = compSection || compSection2 || "";
    const boldNames = section.matchAll(/\*\*([^*\n]{3,40})\*\*/g);
    for (const m of boldNames) {
      const name = cleanPhrase(m[1])
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      if (name && name.length > 1 && !/^(?:and|for|with|from|are|has|not|its|styled|style)$/.test(name)) {
        names.add(name);
      }
      if (names.size >= 12) break;
    }
  }

  const tableRows = body.matchAll(/^\|(.+)\|$/gm);
  for (const row of tableRows) {
    const cells = row[1].split("|").map((cell) => cleanPhrase(cell).trim()).filter(Boolean);
    const candidate = cells.find((cell) => /button|card|tile|panel|table|nav|input|search|badge|chip|hero|workflow|terminal|code|prompt|payment|article|playlist|menu|plan|device/i.test(cell));
    if (candidate && !/^(component|token|name|description|usage|role)$/i.test(candidate)) {
      names.add(normalizeTokenLabel(candidate, `component-${names.size + 1}`));
    }
    if (names.size >= 18) break;
  }

  for (const match of body.matchAll(/`([^`\n]{3,44})`/g)) {
    const candidate = match[1];
    if (!/button|card|tile|panel|table|nav|input|search|badge|chip|hero|workflow|terminal|code|prompt|payment|article|playlist|menu|plan|device/i.test(candidate)) continue;
    names.add(normalizeTokenLabel(candidate, `component-${names.size + 1}`));
    if (names.size >= 18) break;
  }

  const weighted = Array.from(names).sort((a, b) => {
    const rank = (name: string) => {
      if (/prompt|terminal|code|workflow|payment|market|article|editorial|playlist|menu|plan|vehicle|product|property|search/.test(name)) return 0;
      if (/button|card|tile|panel|nav|input|badge|chip|hero/.test(name)) return 1;
      return 2;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  }).slice(0, 18);

  return weighted.map((name) => ({
    name,
    kind: componentKind(name),
    raw: {},
    styles: {},
    source: "markdown",
    sourceEvidence: sourceEvidence("markdown-heading", `markdown.Components.${name}`, "medium", name),
  }));
}

function inferArchetypeWithEvidence(
  slug: string,
  phrases: string[],
  keywords: string[],
  componentNames: string[],
): { archetype: DesignMdArchetype; evidence: DesignMdSourceEvidence } {
  const sourceText = [...phrases, ...keywords, ...componentNames].join(" ");
  const text = [slug, sourceText].join(" ").toLowerCase();
  const score = (patterns: RegExp[]) => patterns.reduce((sum, re) => sum + (re.test(text) ? 1 : 0), 0);
  const scores: Record<DesignMdArchetype, number> = {
    marketplace: score([/marketplace/, /property/, /listing/, /guest/, /booking/, /search-bar/, /homes/, /ride/, /mobility/]),
    product_gallery: score([/photography-first/, /product tile/, /product-tile/, /sparse/, /museum/, /apple/]),
    finance_dashboard: score([/trading/, /markets/, /crypto/, /balance/, /deposit/, /asset-row/, /coinbase|binance/]),
    developer_docs: score([/docs/, /api/, /code-window/, /cli/, /infrastructure/, /supabase/]),
    developer_product: score([/developer product/, /developer platform/, /developer tool/, /deployment/, /infrastructure/]),
    luxury_automotive: score([/automotive/, /vehicle/, /model-card/, /inventory-card/, /bmw|bugatti|ferrari|lamborghini|tesla/, /luxury/, /performance/]),
    data_product: score([/data product/, /analytics/, /database/, /query/, /metrics/, /clickhouse|cohere/]),
    collaboration_saas: score([/messaging/, /workplace/, /collaboration/, /aubergine/, /pastel-mesh/, /slack|slacc/]),
    editorial: score([/editorial/, /magazine/, /story/, /article/, /publication/, /news/, /journalism/]),
    media_editorial: score([/media editorial/, /media brand/, /tech news/, /digital publication/, /the.?verge|wired/]),
    ai_product: score([/ai/, /artificial intelligence/, /model/, /prompt/, /ai product/, /ai platform/, /llm/, /language model/, /generated/]),
    ai_agent_product: score([/ai agent/, /agent product/, /autonomous agent/, /agent workflow/, /orchestration/]),
    creative_tool: score([/creative tool/, /no-code/, /visual development/, /design tool/, /canvas/, /web design/, /webflow|framer/]),
    payment_finance: score([/payment/, /card network/, /financial/, /spend/, /transaction/, /mastercard|wise|stripe/]),
    retail_food: score([/coffee/, /beverage/, /cafe/, /restaurant/, /food/, /drink/, /menu/, /starbucks/, /retail food/]),
    retail_brand: score([/retail brand/, /brand system/, /consumer brand/, /nike/, /shopify/]),
    telecom_service: score([/telecom/, /mobile network/, /service provider/, /broadband/, /connectivity/, /carrier/, /vodafone/, /plan card/]),
    automation_workflow: score([/automation/, /workflow/, /zap/, /pipeline/, /integration/, /connect app/, /zapier/]),
    music_campaign: score([/music/, /playlist/, /album/, /player/, /listening/, /podcast/, /spotify/, /audio/]),
    terminal_tool: score([/terminal/, /command line/, /warp/, /shell/]),
    generic_system: 0,
  };

  const slugLower = slug.toLowerCase();

  // Slug-specific hints as tiebreakers
  if (/(runwayml|runway)/.test(slugLower)) {
    scores.ai_product = Math.max(scores.ai_product, 1) + 7;
    scores.creative_tool = Math.max(scores.creative_tool, 1) + 3;
  }
  if (/(cursor)/.test(slugLower)) {
    scores.developer_product = Math.max(scores.developer_product, 1) + 7;
    scores.ai_product = Math.max(scores.ai_product, 1) + 5;
  }
  if (/(together\.ai|together\.dev)/.test(slugLower) && scores.ai_product > 0) scores.ai_product += 4;
  if (/(voltagent)/.test(slugLower)) {
    scores.ai_agent_product = Math.max(scores.ai_agent_product, 1) + 8;
    scores.ai_product = Math.max(scores.ai_product, 1) + 2;
  }
  if (/(lovable)/.test(slugLower) && scores.ai_product > 0) scores.ai_product += 4;
  if (/(x\.ai)/.test(slugLower) && scores.ai_product > 0) scores.ai_product += 4;
  if (/(webflow)/.test(slugLower) && scores.creative_tool > 0) scores.creative_tool += 5;
  if (/(warp)/.test(slugLower) && scores.terminal_tool > 0) scores.terminal_tool += 5;
  if (/(spotify)/.test(slugLower)) {
    if (scores.music_campaign > 0) scores.music_campaign += 6;
  }
  if (/(starbucks)/.test(slugLower)) {
    scores.retail_food = Math.max(scores.retail_food, 1) + 6;
  }
  if (/(mastercard)/.test(slugLower)) {
    if (scores.payment_finance > 0) scores.payment_finance += 5;
    scores.retail_brand = Math.max(scores.retail_brand, 1) + 2;
  }
  if (/(wise)/.test(slugLower)) scores.payment_finance = Math.max(scores.payment_finance, 1) + 4;
  if (/(theverge|wired)/.test(slugLower)) {
    scores.media_editorial = Math.max(scores.media_editorial, 1) + 8;
    scores.editorial = Math.max(scores.editorial, 1) + 2;
  }
  if (/(uber)/.test(slugLower)) scores.marketplace = Math.max(scores.marketplace, 1) + 4;
  if (/(vodafone)/.test(slugLower)) {
    scores.telecom_service = Math.max(scores.telecom_service, 1) + 6;
  }
  if (/(zapier)/.test(slugLower)) {
    scores.automation_workflow = Math.max(scores.automation_workflow, 1) + 6;
    scores.developer_docs = Math.max(scores.developer_docs, 1) + 2;
  }
  if (/(kraken)/.test(slugLower)) scores.finance_dashboard = Math.max(scores.finance_dashboard, 1) + 5;
  if (/(kraken|binance|coinbase|revolut)/.test(text)) scores.finance_dashboard = Math.max(scores.finance_dashboard, 1) + 2;
  if (/(bmw|bugatti|ferrari|lamborghini|tesla)/.test(slugLower)) scores.luxury_automotive = Math.max(scores.luxury_automotive, 1) + 4;
  if (/(sanity)/.test(slugLower)) {
    scores.developer_product = Math.max(scores.developer_product, 1) + 5;
    scores.developer_docs = Math.max(scores.developer_docs, 1) + 3;
  }
  if (/(vercel)/.test(slugLower)) {
    scores.developer_product = Math.max(scores.developer_product, 1) + 5;
    scores.developer_docs = Math.max(scores.developer_docs, 1) + 4;
  }
  if (/(supabase|opencode)/.test(text)) scores.developer_docs = Math.max(scores.developer_docs, 1) + 4;
  if (/(clickhouse|cohere|mongodb|posthog)/.test(slugLower)) scores.data_product = Math.max(scores.data_product, 1) + 5;
  if (/(shopify|nike)/.test(slugLower)) scores.retail_brand = Math.max(scores.retail_brand, 1) + 5;

  // Content-based boosts
  if (/coffee|beverage|drink|menu item|store card|loyalty/.test(text)) scores.retail_food = Math.max(scores.retail_food, 1) + 3;
  if (/telecom|mobile plan|service plan|coverage|5g|4g|broadband/.test(text)) scores.telecom_service = Math.max(scores.telecom_service, 1) + 3;
  if (/automation|workflow|zap|trigger|action step|integration/.test(text)) scores.automation_workflow = Math.max(scores.automation_workflow, 1) + 3;
  if (/ai agent|autonomous agent|agent orchestration|tool call/.test(text)) scores.ai_agent_product = Math.max(scores.ai_agent_product, 1) + 4;
  if (/developer platform|deployment platform|serverless|edge function/.test(text)) scores.developer_product = Math.max(scores.developer_product, 1) + 3;

  const ordered = Object.entries(scores).sort((a, b) => b[1] - a[1]) as [DesignMdArchetype, number][];
  const archetype = ordered[0][1] > 0 ? ordered[0][0] : "generic_system";
  const componentHit = componentNames.find((name) => new RegExp(archetype.replace(/_/g, "|"), "i").test(name));
  const keywordHit = keywords.find((keyword) => text.includes(keyword.toLowerCase()));
  const phraseHit = phrases.find((phrase) => keywordMatches(phrase).some((keyword) => keywordHit ? keyword === keywordHit : true));
  const slugOnly = ordered[0][1] > 0 && !sourceText.trim();
  return {
    archetype,
    evidence: sourceEvidence(
      slugOnly ? "derived-fallback" : componentHit ? "frontmatter" : keywordHit ? "markdown-paragraph" : "markdown-paragraph",
      slugOnly ? "slug.weak-hint" : componentHit ? `components.${componentHit}` : keywordHit ? `markdown.keyword.${keywordHit}` : "markdown.visual-language",
      archetype === "generic_system" ? "fallback" : slugOnly ? "low" : ordered[0][1] >= 6 ? "high" : "medium",
      componentHit ?? keywordHit ?? phraseHit ?? slug,
    ),
  };
}

function markdownSectionNames(body: string): string[] {
  const found = new Set<string>();
  for (const heading of SECTION_HEADINGS) {
    if (extractSection(body, heading)) found.add(heading);
  }
  return Array.from(found);
}

function hasDarkSignal(value: string): boolean {
  return /dark|black|night|inverse|charcoal|slate|on-dark|on-black|surface-dark|dark card|terminal|code panel|cinematic|aubergine/i.test(value);
}

function hexToRgb(value: string): { r: number; g: number; b: number } | null {
  const hex = value.trim();
  if (!/^#[0-9a-fA-F]{3,8}$/.test(hex)) return null;
  const raw = hex.slice(1);
  const full = raw.length === 3 || raw.length === 4
    ? raw.slice(0, 3).split("").map((c) => c + c).join("")
    : raw.slice(0, 6);
  const int = Number.parseInt(full, 16);
  if (Number.isNaN(int)) return null;
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function relativeLuminance(value: string): number | null {
  const rgb = hexToRgb(value);
  if (!rgb) return null;
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function contrastRatio(a: string | undefined, b: string | undefined): number | null {
  if (!a || !b) return null;
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function likelyContrastRisk(palette: DesignMdPaletteGroup[]): boolean {
  const tokens = palette.flatMap((group) => group.tokens);
  const pick = (re: RegExp) => tokens.find((token) => re.test(token.key) && isSafeColorValue(token.resolvedValue))?.resolvedValue;
  const lightCanvas = pick(/canvas|background|surface|white/i);
  const text = pick(/text|ink|foreground|black|body/i);
  const darkCanvas = pick(/dark|black|night|aubergine/i);
  const onDark = pick(/on-dark|on-black|body-on-dark|text-dark|white/i);
  const lightRatio = contrastRatio(text, lightCanvas);
  const darkRatio = contrastRatio(onDark, darkCanvas);
  return (lightRatio !== null && lightRatio < 3) || (darkRatio !== null && darkRatio < 3);
}

function confidenceFromScore(score: number): DesignMdConfidence {
  if (score >= 6) return "high";
  if (score >= 3) return "medium";
  return "low";
}

function buildCoverage(
  palette: DesignMdPaletteGroup[],
  typography: DesignMdTypographyToken[],
  radius: DesignMdToken[],
  spacing: DesignMdToken[],
  components: DesignMdComponentGroup[],
  body: string,
  fontSubstitutes = "",
): DesignMdPreviewCoverage {
  const colorTokens = palette.flatMap((group) => group.tokens);
  const componentKinds = {} as Record<DesignMdComponentKind, number>;
  for (const component of components) {
    componentKinds[component.kind] = (componentKinds[component.kind] ?? 0) + 1;
  }
  const fonts = new Set<string>();
  for (const token of typography) {
    if (token.fontFamily) {
      for (const font of splitFontFamily(token.fontFamily)) fonts.add(stripQuotes(font));
    }
  }
  return {
    colorsCount: colorTokens.length,
    markdownColorsCount: colorTokens.filter((token) => token.source === "markdown").length,
    typographyCount: typography.length,
    radiusCount: radius.length,
    spacingCount: spacing.length,
    componentCount: components.length,
    componentKinds,
    fontFamilies: Array.from(fonts),
    markdownSections: markdownSectionNames(body),
    darkTokenCount: colorTokens.filter((token) => hasDarkSignal(`${token.key} ${token.rawValue}`)).length,
    darkComponentCount: components.filter((component) => hasDarkSignal(component.name)).length,
    componentGroupsWithEvidenceCount: components.filter((component) => !!component.sourceEvidence).length,
    fontSubstituteHintsCount: fontSubstitutes ? fontSubstitutes.split(/\n|;|,/).filter((item) => item.trim()).length : 0,
  };
}

function buildConfidence(
  archetype: DesignMdArchetype,
  coverage: DesignMdPreviewCoverage,
  structuredCounts: { colors: number; typography: number; components: number },
  phrases: string[],
): DesignMdPreviewConfidence {
  const archetypeScore = (archetype === "generic_system" ? 0 : 2)
    + (phrases.length >= 2 ? 1 : 0)
    + (coverage.componentCount >= 3 ? 1 : 0)
    + (coverage.colorsCount >= 4 ? 1 : 0)
    + (structuredCounts.components > 0 || structuredCounts.colors > 0 ? 1 : 0);
  const lightScore = (coverage.colorsCount >= 4 ? 2 : coverage.colorsCount >= 2 ? 1 : 0)
    + (coverage.typographyCount >= 2 ? 1 : 0)
    + (coverage.componentCount >= 3 ? 2 : coverage.componentCount >= 1 ? 1 : 0)
    + (archetype !== "generic_system" ? 1 : 0);
  const darkScore = lightScore
    + (coverage.darkTokenCount >= 2 ? 2 : coverage.darkTokenCount >= 1 ? 1 : 0)
    + (coverage.darkComponentCount > 0 ? 1 : 0)
    - (coverage.darkTokenCount === 0 ? 1 : 0);
  const componentScore = (coverage.componentCount >= 6 ? 6 : coverage.componentCount >= 3 ? 4 : coverage.componentCount >= 1 ? 2 : 0)
    + (Object.keys(coverage.componentKinds).length >= 3 ? 1 : 0)
    + (structuredCounts.components > 0 ? 1 : 0);
  return {
    archetype: confidenceFromScore(archetypeScore),
    lightPreview: confidenceFromScore(lightScore),
    darkPreview: confidenceFromScore(darkScore),
    components: confidenceFromScore(componentScore),
  };
}

function buildWarnings(
  archetype: DesignMdArchetype,
  coverage: DesignMdPreviewCoverage,
  structuredCounts: { colors: number; typography: number; components: number },
  palette: DesignMdPaletteGroup[],
): DesignMdPreviewWarning[] {
  const warnings: DesignMdPreviewWarning[] = [];
  if (structuredCounts.colors === 0) warnings.push("no structured colors");
  if (structuredCounts.typography === 0) warnings.push("no structured typography");
  if (structuredCounts.components === 0) warnings.push("no structured components");
  if (structuredCounts.colors === 0 && structuredCounts.typography === 0 && structuredCounts.components === 0) warnings.push("markdown-derived-only");
  if (coverage.darkTokenCount === 0) warnings.push("dark tokens derived");
  if (archetype === "generic_system") warnings.push("generic archetype fallback");
  if (coverage.fontFamilies.length === 0) warnings.push("font fallback only");
  if (likelyContrastRisk(palette)) warnings.push("likely contrast risk");
  return warnings;
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
  const phraseEvidence = phrases.map((_, index) => sourceEvidence(
    index === 0 && description ? "frontmatter" : "markdown-paragraph",
    index === 0 && description ? "frontmatter.description" : `markdown.phrases.${index + 1}`,
    index === 0 && description ? "medium" : "low",
  ));
  const keywords = Array.from(new Set(keywordMatches([description, ...phrases].join(" "))));
  const components = buildComponents(fm);
  const semanticProse = [description, body || content].join("\n");
  const structuredPalette = buildPalette(fm, semanticProse);
  const markdownPalette = buildMarkdownPalette(body || content, semanticProse);
  const palette = structuredPalette.length > 0
    ? structuredPalette.map((group) => {
        const mdGroup = markdownPalette.find((candidate) => candidate.name === group.name);
        return mdGroup ? { name: group.name, tokens: group.tokens.concat(mdGroup.tokens.slice(0, Math.max(0, 4 - group.tokens.length))) } : group;
      }).concat(markdownPalette.filter((group) => !structuredPalette.some((structured) => structured.name === group.name)).slice(0, 2))
    : markdownPalette;

  const structuredTypo = buildTypography(fm);
  const mdTypo = buildMarkdownTypography(body);
  const allTypography = structuredTypo.length > 0 ? structuredTypo.concat(mdTypo.slice(0, Math.max(0, 3 - structuredTypo.length))) : mdTypo;
  const mdComponents = buildMarkdownComponents(body || content);
  const structuredComponentNames = components.map((component) => component.name);
  const mergedMdComponents = mdComponents.filter((component) => {
    return !structuredComponentNames.some((name) => name === component.name || name.startsWith(`${component.name}-`) || component.name.startsWith(`${name}-`));
  });
  const allComponents = components.length > 0 ? components.concat(mergedMdComponents.slice(0, Math.max(0, 12 - components.length))) : mdComponents;
  const radius = tokensForPrefix(fm, "rounded").concat(tokensForPrefix(fm, "radius"));
  const spacing = tokensForPrefix(fm, "spacing");
  const archetypeResult = inferArchetypeWithEvidence(slug, phrases, keywords, allComponents.map((component) => component.name));
  const archetype = archetypeResult.archetype;
  const fontSubstitutes = extractFontSubstitutes(body);
  const coverage = buildCoverage(palette, allTypography, radius, spacing, allComponents, body || content, fontSubstitutes);
  const structuredCounts = { colors: structuredPalette.reduce((sum, group) => sum + group.tokens.length, 0), typography: structuredTypo.length, components: components.length };
  const confidence = buildConfidence(archetype, coverage, structuredCounts, phrases);
  const warnings = buildWarnings(archetype, coverage, structuredCounts, palette);

  return {
    meta: { slug, title, description },
    palette: palette.length > 0 ? palette : buildMarkdownPalette(body || content, semanticProse),
    typography: allTypography,
    radius,
    spacing,
    components: allComponents,
    visualLanguage: { phrases, keywords, phraseEvidence },
    archetype,
    archetypeEvidence: archetypeResult.evidence,
    coverage,
    confidence,
    warnings,
    overviewText: extractSection(body, "Overview"),
    layoutText: extractSection(body, "Layout"),
    fontSubstitutes,
    guardrailDos: extractListItems(body, "Do"),
    guardrailDonts: extractListItems(body, "Don't"),
  };
}

