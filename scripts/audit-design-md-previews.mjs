import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = path.join(
  process.env.HOME,
  "Library/Application Support/ai.agentworkspace.app/design-catalogs/awesome-design-md/design-md",
);

// Compile TS modules on-the-fly via tsc
const outDir = "/tmp/audit-design-md";

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

execFileSync(
  path.join(repo, "node_modules/.bin/tsc"),
  [
    "--outDir",
    outDir,
    "--module",
    "ES2022",
    "--target",
    "ES2022",
    "--moduleResolution",
    "Bundler",
    "--skipLibCheck",
    "src/lib/designMdPreviewParser.ts",
    "src/lib/designMdSpecimenBuilder.ts",
    "src/lib/designMdHtmlGenerator.ts",
    "src/lib/designMdDisplay.ts",
  ],
  { cwd: repo, stdio: "pipe" },
);

for (const file of ["designMdSpecimenBuilder.js", "designMdHtmlGenerator.js"]) {
  const full = path.join(outDir, file);
  let content = fs.readFileSync(full, "utf8");
  content = content
    .replaceAll('from "./designMdPreviewParser"', 'from "./designMdPreviewParser.js"')
    .replaceAll('from "./designMdSpecimenBuilder"', 'from "./designMdSpecimenBuilder.js"');
  fs.writeFileSync(full, content);
}

const { parseDesignMdForPreview } = await import(
  path.join(outDir, "designMdPreviewParser.js")
);
const { buildBoard } = await import(path.join(outDir, "designMdSpecimenBuilder.js"));
const { generateBoardHtml } = await import(path.join(outDir, "designMdHtmlGenerator.js"));
const { designMdDisplayTitle } = await import(path.join(outDir, "designMdDisplay.js"));

const prioritySlugs = new Set([
  "runwayml", "sanity", "spotify", "starbucks", "tesla", "theverge",
  "together.ai", "uber", "vercel", "vodafone", "voltagent", "warp",
  "webflow", "wired", "wise", "x.ai", "zapier", "kraken",
  "lamborghini", "lovable", "mastercard",
]);

function auditEntry(slug, dirPath) {
  const mdPath = path.join(dirPath, "DESIGN.md");
  if (!fs.existsSync(mdPath)) return null;

  const content = fs.readFileSync(mdPath, "utf8");
  const title = designMdDisplayTitle(slug);
  const description = content.split("\n").slice(0, 3).join(" ").slice(0, 200);

  let model;
  try {
    model = parseDesignMdForPreview(slug, title, description, content);
  } catch (e) {
    return { slug, title, error: String(e) };
  }

  return {
    slug,
    title,
    originalTitle: content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null,
    archetype: model.archetype,
    archetypeConfidence: model.confidence.archetype,
    rendererPath: model.archetype,
    colorCount: model.coverage.colorsCount,
    markdownColorCount: model.coverage.markdownColorsCount,
    typoCount: model.coverage.typographyCount,
    radiusCount: model.coverage.radiusCount,
    spacingCount: model.coverage.spacingCount,
    componentCount: model.coverage.componentCount,
    componentKinds: model.coverage.componentKinds,
    fontFamilies: model.coverage.fontFamilies,
    markdownSections: model.coverage.markdownSections,
    darkTokenCount: model.coverage.darkTokenCount,
    darkComponentCount: model.coverage.darkComponentCount,
    lightConfidence: model.confidence.lightPreview,
    darkConfidence: model.confidence.darkPreview,
    componentConfidence: model.confidence.components,
    warnings: model.warnings,
    overviewLength: model.overviewText?.length ?? 0,
    visualLanguageKeywords: model.visualLanguage.keywords.length,
    visualLanguagePhrases: model.visualLanguage.phrases.length,
    fontSubstitutesLength: model.fontSubstitutes.length,
  };
}

const entries = fs.readdirSync(cacheRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const results = [];
for (const slug of entries) {
  const dirPath = path.join(cacheRoot, slug);
  const result = auditEntry(slug, dirPath);
  if (result) results.push(result);
}

function priorityRank(confidence) {
  return confidence === "low" ? 0 : confidence === "medium" ? 1 : 2;
}

function failureFlags(r) {
  const flags = [];
  if (r.warnings.includes("no structured colors")) flags.push("no structured colors");
  if (r.markdownColorCount === 0) flags.push("no markdown-derived colors");
  if (r.typoCount === 0) flags.push("no typography");
  if (r.componentCount === 0) flags.push("no components");
  if (r.archetype === "generic_system") flags.push("generic archetype");
  if (r.archetypeConfidence === "low") flags.push("weak archetype confidence");
  if (r.darkTokenCount === 0) flags.push("dark tokens missing");
  if (r.warnings.includes("dark tokens derived")) flags.push("dark only derived");
  if (r.warnings.includes("font fallback only")) flags.push("font fallback only");
  if (r.componentConfidence === "low") flags.push("no real component samples");
  if (r.warnings.includes("likely contrast risk")) flags.push("likely contrast risk");
  if (r.componentCount > 24) flags.push("likely overflow risk");
  if (r.visualLanguagePhrases > 8 && r.componentCount < 3) flags.push("too text-heavy");
  if (r.lightConfidence === "low" || r.archetype === "generic_system") flags.push("too generic");
  return flags;
}

for (const r of results) {
  r.failureFlags = failureFlags(r);
}

console.log(`Total entries: ${entries.length}\n`);
console.log("=".repeat(80));
console.log("PRIORITY BROKEN ENTRIES");
console.log("=".repeat(80) + "\n");

for (const r of results) {
  if (!prioritySlugs.has(r.slug)) continue;
  console.log(`- ${r.slug} (${r.title})`);
  if (r.originalTitle) console.log(`  Upstream title: ${r.originalTitle}`);
  console.log(`  Archetype: ${r.archetype} (${r.archetypeConfidence}) | renderer=${r.rendererPath}`);
  console.log(`  Colors: ${r.colorCount} (md ${r.markdownColorCount}) | Typography: ${r.typoCount} | Radius: ${r.radiusCount} | Spacing: ${r.spacingCount} | Components: ${r.componentCount}`);
  console.log(`  Component kinds: ${Object.entries(r.componentKinds).map(([kind, count]) => `${kind}:${count}`).join(", ") || "none"}`);
  console.log(`  Fonts: ${r.fontFamilies.join(", ") || "fallback only"}`);
  console.log(`  Dark tokens: ${r.darkTokenCount} | Dark components: ${r.darkComponentCount}`);
  console.log(`  Light confidence: ${r.lightConfidence} | Dark confidence: ${r.darkConfidence}`);
  console.log(`  Failure flags: ${r.failureFlags.join(", ") || "none"}`);
  console.log(`  MD sections: ${r.markdownSections.join(", ")}`);
  console.log("");
}

// Summary
const genericArchetype = results.filter((r) => r.archetype === "generic_system").length;
const noColors = results.filter((r) => r.colorCount === 0).length;
const noTypo = results.filter((r) => r.typoCount === 0).length;
const noComponents = results.filter((r) => r.componentCount === 0).length;

console.log("=".repeat(80));
console.log("OVERALL SUMMARY");
console.log("=".repeat(80) + "\n");
console.log(`Total entries audited: ${results.length}`);
console.log(`Generic archetype fallback: ${genericArchetype}`);
console.log(`No colors: ${noColors}`);
console.log(`No typography: ${noTypo}`);
console.log(`No components: ${noComponents}`);

console.log("\nFailure summary:");
const failures = new Map();
for (const r of results) {
  for (const flag of r.failureFlags) failures.set(flag, (failures.get(flag) ?? 0) + 1);
}
for (const [flag, count] of [...failures.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(flag).padEnd(28)} ${count}`);
}

console.log("\nLowest confidence priority list:");
for (const r of [...results].sort((a, b) => {
  const diff = priorityRank(a.lightConfidence) + priorityRank(a.darkConfidence) - priorityRank(b.lightConfidence) - priorityRank(b.darkConfidence);
  return diff || b.failureFlags.length - a.failureFlags.length || a.slug.localeCompare(b.slug);
}).slice(0, 24)) {
  console.log(`  ${r.slug.padEnd(18)} light=${r.lightConfidence.padEnd(6)} dark=${r.darkConfidence.padEnd(6)} arch=${r.archetype.padEnd(20)} flags=${r.failureFlags.slice(0, 4).join(", ") || "none"}`);
}

// Archetype distribution for priority entries
console.log("\nPriority archetype distribution:");
for (const r of results.filter((r) => prioritySlugs.has(r.slug))) {
  console.log(`  ${r.slug.padEnd(16)} → ${r.archetype}`);
}

// All entries without frontmatter
// Generate safety check
console.log("\n" + "=".repeat(80));
console.log("GENERATOR SAFETY CHECK (sample entries)");
console.log("=".repeat(80) + "\n");

const testEntries = ["airbnb", "spotify", "runwayml", "tesla", "warp", "webflow", "zapier", "mastercard", "lovable"];
for (const slug of testEntries) {
  const dirPath = path.join(cacheRoot, slug);
  if (!fs.existsSync(dirPath)) continue;
  const content = fs.readFileSync(path.join(dirPath, "DESIGN.md"), "utf8");
  const title = designMdDisplayTitle(slug);
  const board = buildBoard(slug, title, "", content);
  const lightHtml = generateBoardHtml(board, { variant: "light" });
  const darkHtml = generateBoardHtml(board, { variant: "dark" });

  const checks = {
    hasCSP: lightHtml.includes("Content-Security-Policy"),
    noScript: !/<script/i.test(lightHtml),
    noExternalFonts: !/@font-face|@import|url\(https?:/i.test(lightHtml),
    hasCanvas: lightHtml.includes("background"),
    darkHasCSP: darkHtml.includes("Content-Security-Policy"),
    darkNoScript: !/<script/i.test(darkHtml),
    darkDifferentBg: (() => {
      const lb = lightHtml.match(/body\{[^}]+background:([^;]+)/);
      const db = darkHtml.match(/body\{[^}]+background:([^;]+)/);
      return lb?.[1] !== db?.[1];
    })(),
  };

  const allPass = Object.values(checks).every(Boolean);
  console.log(`${allPass ? "✅" : "❌"} ${slug.padEnd(16)} CSP=${checks.hasCSP} NoScript=${checks.noScript} NoExtFonts=${checks.noExternalFonts} DarkCSP=${checks.darkHasCSP} DarkNoScript=${checks.darkNoScript} DarkDiffBg=${checks.darkDifferentBg}`);
}

console.log("\nAudit complete.");
