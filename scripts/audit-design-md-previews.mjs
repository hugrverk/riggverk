import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = path.join(
  process.env.HOME,
  "Library/Application Support/ai.agentworkspace.app/design-catalogs/awesome-design-md/design-md",
);

// Compile TS modules on-the-fly via tsc
const outDir = "/tmp/audit-design-md";

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const { execSync } = await import("node:child_process");
execSync(
  [
    path.join(repo, "node_modules/.bin/tsc"),
    "--outDir", outDir,
    "--module", "ES2022",
    "--target", "ES2022",
    "--moduleResolution", "Bundler",
    "--skipLibCheck",
    "src/lib/designMdPreviewParser.ts",
    "src/lib/designMdSpecimenBuilder.ts",
    "src/lib/designMdHtmlGenerator.ts",
    "src/lib/designMdDisplay.ts",
  ].join(" "),
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

const { parseDesignMdForPreview, resolveGeneratedFontFamily, isSafeColorValue } = await import(
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

function hasYaml(content) {
  return content.trimStart().startsWith("---");
}

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

  const hasFrontmatter = hasYaml(content);
  const colorCount = model.palette.reduce((sum, g) => sum + g.tokens.length, 0);
  const typoCount = model.typography.length;
  const componentCount = model.components.length;
  const fontFamilies = new Set();
  for (const t of model.typography) if (t.fontFamily) fontFamilies.add(t.fontFamily);

  const componentKinds = new Set(model.components.map((c) => c.kind));
  const markdownSections = [];
  for (const h of ["Overview", "Key Characteristics", "Layout", "Components", "Shapes", "Typography", "Colors", "Font Substitutes"]) {
    if (content.match(new RegExp(`^#{1,3}\\s+${h}`, "im"))) markdownSections.push(h);
  }

  // Confidence scores
  let lightConfidence = "low";
  let darkConfidence = "low";
  if (colorCount >= 5 && typoCount >= 3 && componentCount >= 3) {
    lightConfidence = "high";
  } else if (colorCount >= 3 || typoCount >= 1 || componentCount >= 2) {
    lightConfidence = "medium";
  }
  if (lightConfidence === "high") darkConfidence = "high";
  else if (colorCount >= 2 || hasFrontmatter) darkConfidence = "medium";

  const warnings = [];
  if (colorCount === 0) warnings.push("no-structured-colors");
  if (typoCount === 0) warnings.push("no-structured-typography");
  if (componentCount === 0) warnings.push("no-structured-components");
  if (!hasFrontmatter) warnings.push("no-frontmatter");
  if (model.archetype === "generic_system") warnings.push("generic-archetype");
  if (typoCount === 0 && componentCount === 0 && colorCount === 0) warnings.push("markdown-derived-only");

  // Markdown-derived counts
  const mdComponents = model.components.filter((c) => Object.keys(c.raw).length === 0);

  return {
    slug,
    title,
    archetype: model.archetype,
    hasFrontmatter,
    colorCount,
    typoCount,
    componentCount,
    componentKinds: [...componentKinds],
    fontFamilies: [...fontFamilies],
    markdownSections,
    lightConfidence,
    darkConfidence,
    markdownDerivedComponents: mdComponents.length,
    warnings,
    overviewLength: model.overviewText?.length ?? 0,
    visualLanguageKeywords: model.visualLanguage.keywords.length,
    visualLanguagePhrases: model.visualLanguage.phrases.length,
    fontSubstitutesLength: model.fontSubstitutes.length,
  };
}

const entries = fs.readdirSync(cacheRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

console.log(`Total entries: ${entries.length}\n`);
console.log("=".repeat(80));
console.log("PRIORITY BROKEN ENTRIES");
console.log("=".repeat(80) + "\n");

const results = [];
for (const slug of entries) {
  const dirPath = path.join(cacheRoot, slug);
  const result = auditEntry(slug, dirPath);
  if (result) results.push(result);
}

// Print priority entries
for (const r of results) {
  if (!prioritySlugs.has(r.slug)) continue;
  const priority = "🔴";
  console.log(`${priority} ${r.slug} (${r.title})`);
  console.log(`  Archetype: ${r.archetype}`);
  console.log(`  Frontmatter: ${r.hasFrontmatter ? "YES" : "NO"}`);
  console.log(`  Colors: ${r.colorCount} | Typography: ${r.typoCount} | Components: ${r.componentCount}`);
  console.log(`  Component kinds: ${r.componentKinds.join(", ") || "none"}`);
  console.log(`  Light confidence: ${r.lightConfidence} | Dark confidence: ${r.darkConfidence}`);
  console.log(`  Warnings: ${r.warnings.join(", ") || "none"}`);
  console.log(`  MD sections: ${r.markdownSections.join(", ")}`);
  console.log(`  MD-derived components: ${r.markdownDerivedComponents}/${r.componentCount}`);
  console.log("");
}

// Summary
const withFm = results.filter((r) => r.hasFrontmatter).length;
const withoutFm = results.filter((r) => !r.hasFrontmatter).length;
const genericArchetype = results.filter((r) => r.archetype === "generic_system").length;
const noColors = results.filter((r) => r.colorCount === 0).length;
const noTypo = results.filter((r) => r.typoCount === 0).length;
const noComponents = results.filter((r) => r.componentCount === 0).length;

console.log("=".repeat(80));
console.log("OVERALL SUMMARY");
console.log("=".repeat(80) + "\n");
console.log(`Total entries audited: ${results.length}`);
console.log(`With YAML frontmatter: ${withFm}`);
console.log(`Without YAML frontmatter: ${withoutFm}`);
console.log(`Generic archetype fallback: ${genericArchetype}`);
console.log(`No structured colors: ${noColors}`);
console.log(`No structured typography: ${noTypo}`);
console.log(`No structured components: ${noComponents}`);

// Archetype distribution for priority entries
console.log("\nPriority archetype distribution:");
for (const r of results.filter((r) => prioritySlugs.has(r.slug))) {
  console.log(`  ${r.slug.padEnd(16)} → ${r.archetype}`);
}

// All entries without frontmatter
console.log("\nEntries WITHOUT frontmatter:");
for (const r of results.filter((r) => !r.hasFrontmatter)) {
  console.log(`  ${r.slug.padEnd(20)} arch=${r.archetype.padEnd(20)} colors=${r.colorCount} typo=${r.typoCount} comps=${r.componentCount} light=${r.lightConfidence.padEnd(6)} dark=${r.darkConfidence}`);
}

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
