import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = path.join(
  process.env.HOME,
  "Library/Application Support/ai.agentworkspace.app/design-catalogs/awesome-design-md/design-md",
);
const outDir = process.argv[2] ?? "/tmp/design-md-preview-fixtures";
const runtimeNodeModules = process.env.CODEX_NODE_MODULES
  ?? path.join(process.env.HOME, ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules");
const requireFromRuntime = createRequire(path.join(runtimeNodeModules, "package.json"));
const { chromium } = requireFromRuntime("playwright");

const slugs = [
  "claude",
  "cursor",
  "runwayml", "sanity", "spotify", "starbucks", "tesla", "theverge",
  "together.ai", "uber", "vercel", "vodafone", "voltagent", "warp",
  "webflow", "wired", "wise", "x.ai", "zapier", "kraken",
  "lamborghini", "lovable", "mastercard",
  "airbnb", "apple", "binance", "slack", "shopify", "bmw", "bmw-m", "clickhouse", "coinbase", "supabase",
];

const tsOutDir = path.join(outDir, "_compiled");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(tsOutDir, { recursive: true });

execFileSync(
  path.join(repo, "node_modules/.bin/tsc"),
  [
    "--outDir",
    tsOutDir,
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
    "src/lib/designMdColorSemantics.ts",
    "src/lib/designMdTokenRoleResolver.ts",
    "src/lib/designMdThemeResolver.ts",
    "src/lib/designMdSourceIntent.ts",
    "src/lib/designMdRenderEligibility.ts",
    "src/lib/designMdContrast.ts",
    "src/lib/designMdDisplay.ts",
    "src/lib/designMdSourceEvidence.ts",
    "src/lib/designMdPreviewQuality.ts",
  ],
  { cwd: repo, stdio: "pipe" },
);

for (const file of ["designMdPreviewParser.js", "designMdSpecimenBuilder.js", "designMdHtmlGenerator.js", "designMdColorSemantics.js", "designMdTokenRoleResolver.js", "designMdThemeResolver.js", "designMdSourceIntent.js", "designMdRenderEligibility.js", "designMdContrast.js", "designMdSourceEvidence.js", "designMdPreviewQuality.js"]) {
  const fullPath = path.join(tsOutDir, file);
  const content = fs.readFileSync(fullPath, "utf8")
    .replaceAll('from "./designMdPreviewParser"', 'from "./designMdPreviewParser.js"')
    .replaceAll('from "./designMdSpecimenBuilder"', 'from "./designMdSpecimenBuilder.js"')
    .replaceAll('from "./designMdColorSemantics"', 'from "./designMdColorSemantics.js"')
    .replaceAll('from "./designMdTokenRoleResolver"', 'from "./designMdTokenRoleResolver.js"')
    .replaceAll('from "./designMdThemeResolver"', 'from "./designMdThemeResolver.js"')
    .replaceAll('from "./designMdSourceIntent"', 'from "./designMdSourceIntent.js"')
    .replaceAll('from "./designMdRenderEligibility"', 'from "./designMdRenderEligibility.js"')
    .replaceAll('from "./designMdContrast"', 'from "./designMdContrast.js"')
    .replaceAll('from "./designMdSourceEvidence"', 'from "./designMdSourceEvidence.js"')
    .replaceAll('from "./designMdPreviewQuality"', 'from "./designMdPreviewQuality.js"');
  fs.writeFileSync(fullPath, content);
}

const { buildBoard } = await import(path.join(tsOutDir, "designMdSpecimenBuilder.js"));
const { generateBoardHtml } = await import(path.join(tsOutDir, "designMdHtmlGenerator.js"));
const { designMdDisplayTitle } = await import(path.join(tsOutDir, "designMdDisplay.js"));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1180, height: 920 }, deviceScaleFactor: 1 });
const results = [];

for (const slug of slugs) {
  const mdPath = path.join(cacheRoot, slug, "DESIGN.md");
  if (!fs.existsSync(mdPath)) continue;
  const content = fs.readFileSync(mdPath, "utf8");
  const board = buildBoard(slug, designMdDisplayTitle(slug), "", content);
  for (const variant of ["light", "dark"]) {
    const html = generateBoardHtml(board, { variant });
    const htmlPath = path.join(outDir, `${slug}-${variant}.html`);
    const pngPath = path.join(outDir, `${slug}-${variant}.png`);
    fs.writeFileSync(htmlPath, html);
    await page.setContent(html, { waitUntil: "load" });
    const metrics = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      height: document.documentElement.scrollHeight,
      text: document.body.innerText.slice(0, 500),
      scripts: document.querySelectorAll("script").length,
      externalUrls: Array.from(document.querySelectorAll("[src],[href]"))
        .map((el) => el.getAttribute("src") || el.getAttribute("href"))
        .filter((value) => value && /^https?:/i.test(value)).length,
    }));
    await page.screenshot({ path: pngPath, fullPage: true });
    results.push({
      slug,
      variant,
      archetype: board.archetype,
      lightConfidence: board.confidence.lightPreview,
      darkConfidence: board.confidence.darkPreview,
      warnings: board.warnings,
      screenshot: pngPath,
      horizontalOverflow: metrics.width > metrics.clientWidth + 1,
      scripts: metrics.scripts,
      externalUrls: metrics.externalUrls,
    });
  }
}

await browser.close();
fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));

for (const result of results) {
  console.log(`${result.slug.padEnd(14)} ${result.variant.padEnd(5)} arch=${result.archetype.padEnd(20)} overflow=${result.horizontalOverflow} scripts=${result.scripts} external=${result.externalUrls} ${result.screenshot}`);
}
console.log(`Rendered ${results.length} previews to ${outDir}`);
