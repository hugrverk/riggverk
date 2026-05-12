export type DesignMdMood =
  | "warm"
  | "cool"
  | "neutral"
  | "editorial"
  | "soft"
  | "stark"
  | "highContrast"
  | "minimal"
  | "playful"
  | "technical"
  | "luxury"
  | "terminal"
  | "darkNative"
  | "lightFirst";

export type DesignMdCanvasIntent =
  | "light"
  | "dark"
  | "warmLight"
  | "offWhite"
  | "cream"
  | "black"
  | "neutral"
  | "unknown";

export type DesignMdAccentIntent =
  | "sparse"
  | "supporting"
  | "dominant"
  | "ctaOnly"
  | "wordmarkOnly"
  | "semanticOnly"
  | "timelineOnly"
  | "decorativeOnly"
  | "unknown";

export type DesignMdDarkModeIntent =
  | "explicitDark"
  | "darkNative"
  | "lightFirstDerived"
  | "neutralDerived"
  | "unknown";

export type DesignMdContrastIntent = "soft" | "moderate" | "high" | "unknown";

export interface DesignMdSourceIntentEvidence {
  section: string;
  excerpt: string;
}

export interface DesignMdSourceIntent {
  mood: DesignMdMood[];
  canvasIntent: DesignMdCanvasIntent;
  accentIntent: DesignMdAccentIntent[];
  darkModeIntent: DesignMdDarkModeIntent;
  contrastIntent: DesignMdContrastIntent;
  sourceEvidence: DesignMdSourceIntentEvidence[];
}

function frontmatterValue(content: string, key: string): string {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return "";
  const afterOpen = trimmed.slice(3);
  const closing = afterOpen.match(/\n---\s*(\n|$)/);
  if (!closing || closing.index === undefined) return "";
  const fm = afterOpen.slice(0, closing.index);
  const match = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
}

function markdownBody(content: string): string {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return content;
  const afterOpen = trimmed.slice(3);
  const closing = afterOpen.match(/\n---\s*(\n|$)/);
  if (!closing || closing.index === undefined) return "";
  return afterOpen.slice(closing.index + closing[0].length);
}

function cleanText(value: string): string {
  return value
    .replace(/\{([^}]+)\}/g, "$1")
    .replace(/[`*_>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sectionText(body: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`^#{1,4}\\s+[^\\n]*\\b${escaped}\\b[^\\n]*$`, "im"));
  if (!match || match.index === undefined) return "";
  const after = body.slice(match.index + match[0].length);
  const next = after.match(/\n#{1,4}\s/);
  return (next && next.index !== undefined ? after.slice(0, next.index) : after).trim();
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function addEvidence(
  evidence: DesignMdSourceIntentEvidence[],
  section: string,
  text: string,
  patterns: RegExp[],
): void {
  if (!text || evidence.length >= 8) return;
  const sentences = cleanText(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 20);
  const found = sentences.find((sentence) => hasAny(sentence.toLowerCase(), patterns));
  if (found) {
    evidence.push({ section, excerpt: found.slice(0, 220) });
  }
}

function uniq<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function analyzeDesignMdSourceIntent(content: string, title: string, description: string): DesignMdSourceIntent {
  const body = markdownBody(content);
  const sections = [
    ["description", description || frontmatterValue(content, "description")],
    ["overview", sectionText(body, "Overview")],
    ["key characteristics", sectionText(body, "Key Characteristics")],
    ["colors", sectionText(body, "Colors") || sectionText(body, "Color Palette") || sectionText(body, "Color Palette & Roles")],
    ["layout", sectionText(body, "Layout")],
    ["typography", sectionText(body, "Typography") || sectionText(body, "Typography Rules")],
    ["components", sectionText(body, "Components") || sectionText(body, "Component Stylings") || sectionText(body, "Key Components")],
  ] as const;
  const sourceText = cleanText([title, ...sections.map(([, text]) => text)].filter(Boolean).join("\n"));
  const text = sourceText.toLowerCase();
  const mood: DesignMdMood[] = [];
  const accentIntent: DesignMdAccentIntent[] = [];
  const evidence: DesignMdSourceIntentEvidence[] = [];

  const addMood = (enabled: boolean, value: DesignMdMood, patterns: RegExp[]) => {
    if (enabled) {
      mood.push(value);
      for (const [section, sectionValue] of sections) addEvidence(evidence, section, sectionValue, patterns);
    }
  };
  const addAccent = (enabled: boolean, value: DesignMdAccentIntent, patterns: RegExp[]) => {
    if (enabled) {
      accentIntent.push(value);
      for (const [section, sectionValue] of sections) addEvidence(evidence, section, sectionValue, patterns);
    }
  };

  addMood(hasAny(text, [/\bwarm\b/, /warm[-\s](?:cream|canvas|gray|grey|black|dark|ink)/]), "warm", [/\bwarm\b/]);
  addMood(hasAny(text, [/\bcool\b/, /\bblue[-\s]tinted\b/]) && !/\bnot cold\b/.test(text), "cool", [/\bcool\b/, /\bblue[-\s]tinted\b/]);
  addMood(hasAny(text, [/\beditorial\b/, /\bmagazine\b/, /\bpublication\b/, /\bmuseum gallery\b/]), "editorial", [/\beditorial\b/, /\bmagazine\b/, /\bpublication\b/, /\bmuseum gallery\b/]);
  addMood(hasAny(text, [/\bsoft\b/, /\bgentle\b/, /\blow[-\s]contrast\b/, /\bquiet\b/, /\bcalm\b/]), "soft", [/\bsoft\b/, /\bgentle\b/, /\blow[-\s]contrast\b/, /\bquiet\b/, /\bcalm\b/]);
  addMood(hasAny(text, [/\bstark\b/, /\baustere\b/, /\bradical subtraction\b/]), "stark", [/\bstark\b/, /\baustere\b/, /\bradical subtraction\b/]);
  addMood(hasAny(text, [/\bhigh[-\s]contrast\b/, /\bhighest[-\s]contrast\b/]), "highContrast", [/\bhigh[-\s]contrast\b/, /\bhighest[-\s]contrast\b/]);
  addMood(hasAny(text, [/\bminimal\b/, /\bminimalism\b/, /\bmonochromatic\b/, /\brestrained\b/]), "minimal", [/\bminimal\b/, /\bminimalism\b/, /\bmonochromatic\b/, /\brestrained\b/]);
  addMood(hasAny(text, [/\bplayful\b/, /\bfriendly\b/, /\bhuman\b/]), "playful", [/\bplayful\b/, /\bfriendly\b/, /\bhuman\b/]);
  addMood(hasAny(text, [/\bdeveloper\b/, /\bcode\b/, /\bengineering\b/, /\btechnical\b/]), "technical", [/\bdeveloper\b/, /\bcode\b/, /\bengineering\b/, /\btechnical\b/]);
  addMood(hasAny(text, [/\bluxury\b/, /\bpremium\b/, /\bautomotive\b/]), "luxury", [/\bluxury\b/, /\bpremium\b/, /\bautomotive\b/]);
  addMood(hasAny(text, [/\bterminal\b/, /\bconsole\b/, /\bcode editor\b/, /\bcode surface\b/]), "terminal", [/\bterminal\b/, /\bconsole\b/, /\bcode editor\b/, /\bcode surface\b/]);

  const darkNative = hasAny(text, [
    /\bdark[-\s]native\b/,
    /\bdark theme\b/,
    /\bdark immersive\b/,
    /\bimmersive dark\b/,
    /\bnear[-\s]black canvas\b/,
    /\bblack canvas\b/,
    /\bdeep near[-\s]black canvas\b/,
    /\bmarketing and product surfaces default to the dark theme\b/,
    /\bdark, immersive\b/,
    /\bdark immersive music player\b/,
  ]);
  const lightFirst = hasAny(text, [
    /\blight[-\s]first\b/,
    /\blight[-\s]dominant\b/,
    /\bwhite backgrounds?\b/,
    /\bwhite canvas\b/,
    /\bclean white canvas\b/,
    /\bwarm[-\s]cream editorial canvas\b/,
    /\btinted cream canvas\b/,
    /\binstead of the typical dark ide atmosphere\b/,
    /\bnot (?:a )?dark ide\b/,
    /\bnot dark\b/,
    /\bdaytime\/light-dominant\b/,
  ]);
  addMood(darkNative, "darkNative", [/\bdark theme\b/, /\bnear[-\s]black canvas\b/, /\bblack canvas\b/, /\bdark, immersive\b/]);
  addMood(lightFirst, "lightFirst", [/\blight[-\s]dominant\b/, /\bwhite canvas\b/, /\bwarm[-\s]cream editorial canvas\b/, /\btinted cream canvas\b/, /\bnot (?:a )?dark ide\b/]);

  addAccent(hasAny(text, [/\bsparse\b/, /\bsparingly\b/, /\bused scarcely\b/, /\buse scarcely\b/, /\breserved\b/, /\bscarce\b/]), "sparse", [/\bsparse\b/, /\bsparingly\b/, /\bused scarcely\b/, /\breserved\b/]);
  addAccent(hasAny(text, [/\bprimary ctas?\b/, /\bcta only\b/, /\bonly for (?:rare )?(?:primary )?ctas?\b/, /\bprimary action\b/]), "ctaOnly", [/\bprimary ctas?\b/, /\bcta only\b/, /\bonly for (?:rare )?(?:primary )?ctas?\b/]);
  addAccent(hasAny(text, [/\bwordmark\b/, /\blogo\b/]), "wordmarkOnly", [/\bwordmark\b/, /\blogo\b/]);
  addAccent(hasAny(text, [/\bsemantic\b/, /\bvalidation\b/, /\bsuccess\b/, /\berror\b/]), "semanticOnly", [/\bsemantic\b/, /\bvalidation\b/]);
  addAccent(hasAny(text, [/\btimeline\b/, /\bonly inside in-product timeline\b/, /\btimeline visualizations?\b/]), "timelineOnly", [/\btimeline\b/, /\bonly inside in-product timeline\b/]);
  addAccent(hasAny(text, [/\bdecorative only\b/, /\bdecoration\b/]), "decorativeOnly", [/\bdecorative\b/, /\bdecoration\b/]);
  addAccent(hasAny(text, [/\bdominant\b/, /\bcommanding brand color\b/, /\bcarries every primary cta\b/, /\bsingular brand voltage\b/]), "dominant", [/\bdominant\b/, /\bcommanding brand color\b/, /\bsingular brand voltage\b/]);
  if (accentIntent.length === 0 && hasAny(text, [/\baccent\b/, /\bprimary\b/, /\bbrand color\b/])) accentIntent.push("supporting");

  let canvasIntent: DesignMdCanvasIntent = "unknown";
  if (hasAny(text, [/\bcream\b/, /\btinted cream\b/, /\bputty-cream\b/])) canvasIntent = "cream";
  else if (hasAny(text, [/\boff[-\s]white\b/, /\bparchment\b/])) canvasIntent = "offWhite";
  else if (hasAny(text, [/\bwarm canvas\b/, /\bwarm[-\s]cream\b/, /\bwarm light\b/])) canvasIntent = "warmLight";
  else if (hasAny(text, [/\bblack canvas\b/, /\bnear[-\s]pure black\b/, /\balmost-black\b/])) canvasIntent = "black";
  else if (darkNative) canvasIntent = "dark";
  else if (lightFirst || hasAny(text, [/\bwhite canvas\b/, /\bwhite backgrounds?\b/, /\blight\b/])) canvasIntent = "light";
  else if (hasAny(text, [/\bneutral\b/, /\bgray\b/, /\bgrey\b/])) canvasIntent = "neutral";

  let darkModeIntent: DesignMdDarkModeIntent = "unknown";
  if (darkNative) darkModeIntent = "darkNative";
  else if (lightFirst || canvasIntent === "cream" || canvasIntent === "offWhite" || canvasIntent === "warmLight") darkModeIntent = "lightFirstDerived";
  else if (hasAny(text, [/\bdark token\b/, /\bon-dark\b/, /\binverse\b/, /\bnight\b/])) darkModeIntent = "explicitDark";
  else if (canvasIntent === "neutral") darkModeIntent = "neutralDerived";

  let contrastIntent: DesignMdContrastIntent = "unknown";
  if (hasAny(text, [/\blow[-\s]contrast\b/, /\bsoft\b/, /\bgentle\b/, /\bquiet\b/])) contrastIntent = "soft";
  else if (hasAny(text, [/\bhigh[-\s]contrast\b/, /\bhighest[-\s]contrast\b/, /\bstark\b/])) contrastIntent = "high";
  else if (sourceText) contrastIntent = "moderate";

  if (evidence.length === 0 && description) {
    evidence.push({ section: "description", excerpt: cleanText(description).slice(0, 220) });
  }

  return {
    mood: uniq(mood),
    canvasIntent,
    accentIntent: uniq(accentIntent.length > 0 ? accentIntent : ["unknown"]),
    darkModeIntent,
    contrastIntent,
    sourceEvidence: evidence.slice(0, 8),
  };
}

export function sourceIntentSummary(intent: DesignMdSourceIntent): string {
  const parts = [
    intent.mood.slice(0, 5).join(", "),
    intent.canvasIntent !== "unknown" ? `${intent.canvasIntent} canvas` : "",
    intent.accentIntent.filter((value) => value !== "unknown").slice(0, 3).join(", "),
    intent.darkModeIntent !== "unknown" ? intent.darkModeIntent : "",
    intent.contrastIntent !== "unknown" ? `${intent.contrastIntent} contrast` : "",
  ].filter(Boolean);
  return parts.join(" · ") || "source intent unclear";
}
