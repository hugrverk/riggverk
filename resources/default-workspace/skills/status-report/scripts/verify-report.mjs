#!/usr/bin/env node
// Verifies a status report. Node 18+, no dependencies; the browser pass is optional.
//   node verify-report.mjs <report.json> [<report.html>] [--no-browser] [--require-browser] [--playwright-dir=<dir>]
// Data:  schema, cited sources resolve, dates inside the period, health matches the risks,
//        progress has a basis, no secret, e-mail or home-path patterns.
// HTML:  no external requests (Google Fonts excepted), no unrendered tags, every item title in the
//        markup without JavaScript, embedded JSON equals report.json, reduced-motion and print rules.
// Browser (only when --playwright-dir=<dir> names a directory the user approved, holding node_modules/playwright;
//        `playwright` is never resolved from the current directory or the repository): 1280 and 390 px, JavaScript
//        off and on, no overflow, no page errors, no network beyond file:/data:/fonts, every title
//        visible, and no endless animation under prefers-reduced-motion.
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith("--")));
const [jsonPath, htmlPath] = args.filter(a => !a.startsWith("--"));
if (!jsonPath) {
  console.error("usage: node verify-report.mjs <report.json> [<report.html>] [--no-browser] [--require-browser] [--playwright-dir=<dir>]");
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const failures = [];
const warnings = [];
const fail = msg => failures.push(msg);

// --- Schema (the subset report.schema.json uses) --------------------------------------------
const SUPPORTED = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description", "type", "const", "enum", "required",
  "properties", "additionalProperties", "items", "minItems", "maxItems", "minimum", "maximum",
  "minLength", "maxLength", "pattern",
]);
function validate(schema, value, path, root) {
  for (const key of Object.keys(schema)) if (!SUPPORTED.has(key)) throw new Error(`schema keyword ${key} at ${path} is not supported`);
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((s, k) => s?.[k], root);
    if (!target) throw new Error(`unresolved $ref ${schema.$ref}`);
    return validate(target, value, path, root);
  }
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type && !(schema.type === type || (schema.type === "integer" && Number.isInteger(value)))) {
    return fail(`${path}: expected ${schema.type}, got ${type}`);
  }
  if ("const" in schema && value !== schema.const) fail(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`${path}: ${JSON.stringify(value)} not in ${schema.enum.join("|")}`);
  if (type === "string") {
    if (schema.minLength != null && value.length < schema.minLength) fail(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) fail(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) fail(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }
  if (type === "number") {
    if (schema.minimum != null && value < schema.minimum) fail(`${path}: below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) fail(`${path}: above ${schema.maximum}`);
  }
  if (type === "array") {
    if (schema.minItems != null && value.length < schema.minItems) fail(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) fail(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, root));
  }
  if (type === "object") {
    for (const key of schema.required ?? []) if (!(key in value)) fail(`${path}: missing ${key}`);
    for (const [key, v] of Object.entries(value)) {
      if (schema.properties?.[key]) validate(schema.properties[key], v, `${path}.${key}`, root);
      else if (schema.additionalProperties === false) fail(`${path}: unknown field ${key}`);
    }
  }
}

// --- Leak patterns, shared by the JSON and the HTML -----------------------------------------
const LEAKS = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["AWS key", /\b(AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["API key", /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./],
  ["bearer header", /\b(authorization|bearer)\s*[:=]?\s*(bearer\s+)?[A-Za-z0-9._~+/-]{20,}/i],
  ["credential assignment", /\b(password|passwd|secret|token|api[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"'<]{6,}/i],
  ["URL with credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'<>]+:[^\s/@"'<>]+@/i],
  ["URL with a secret parameter", /[?&](token|access_token|key|api_key|sig|signature|secret|code|auth)=[^&\s"'<]{6,}/i],
  ["home path", /(\/Users\/|\/home\/)[^/\s"'<]+\/|[A-Z]:\\Users\\[^\\\s"'<]+\\/],
  ["e-mail address", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
];
const scanLeaks = (label, text) => {
  for (const [name, re] of LEAKS) {
    const m = text.match(re);
    if (m) fail(`${label}: ${name} pattern at offset ${m.index} (value not printed)`);
  }
};

// --- report.json ---------------------------------------------------------------------------
const jsonText = readFileSync(jsonPath, "utf8");
let report;
try {
  report = JSON.parse(jsonText);
} catch (error) {
  console.error(`FAIL: ${jsonPath} is not JSON: ${error.message}`);
  process.exit(1);
}
const schemaPath = [join(here, "..", "report.schema.json"), join(here, "..", "assets", "report.schema.json")].find(existsSync);
if (!schemaPath) throw new Error("report.schema.json not found next to the skill");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
validate(schema, report, "report", schema);
scanLeaks("report.json", jsonText);

if (!failures.length) {
  const { period, sources } = report;
  const lists = ["metrics", "happened", "happening", "next", "risks", "decisions"];
  const ids = new Set();
  for (const s of sources) {
    if (ids.has(s.id)) fail(`sources: duplicate id ${s.id}`);
    ids.add(s.id);
  }
  const used = new Set(report.health.cite);
  for (const id of report.health.cite) if (!ids.has(id)) fail(`health cites unknown source ${id}`);
  for (const list of lists) {
    (report[list] ?? []).forEach((item, i) => {
      for (const id of item.cite) {
        used.add(id);
        if (!ids.has(id)) fail(`${list}[${i}] cites unknown source ${id}`);
      }
    });
  }
  for (const id of ids) if (!used.has(id)) warnings.push(`source ${id} is listed but never cited`);

  if (period.from > period.to) fail(`period: from ${period.from} is after to ${period.to}`);
  for (const list of ["happened", "decisions"]) {
    (report[list] ?? []).forEach((item, i) => {
      if (item.date < period.from || item.date > period.to) fail(`${list}[${i}] date ${item.date} is outside ${period.from}..${period.to}`);
    });
  }
  (report.next ?? []).forEach((n, i) => {
    if (n.when && n.when < period.from.slice(0, n.when.length) && !n.when.includes("Q")) fail(`next[${i}] when ${n.when} is before the period`);
  });
  const generatedDay = report.generated.slice(0, 10);
  if (generatedDay < period.from) fail(`generated ${generatedDay} is before the period`);
  if (Date.parse(report.generated) > Date.now() + 36 * 3600e3) fail(`generated ${report.generated} is in the future`);
  for (const s of sources) if (s.at.slice(0, 10) > generatedDay) fail(`source ${s.id} was read after the report was generated`);

  (report.happening ?? []).forEach((h, i) => {
    if ((h.progress == null) !== (h.progress_basis == null)) fail(`happening[${i}]: progress and progress_basis go together`);
  });
  const high = (report.risks ?? []).some(r => r.severity === "high");
  const blockedWork = (report.happening ?? []).some(h => h.status === "blocked");
  if (report.health.state === "on-track" && high) fail("health is on-track but a risk is high");
  if (report.health.state === "blocked" && !high && !blockedWork) fail("health is blocked but nothing is blocked and no risk is high");
  if (!report.happened.length && !report.gaps?.length) warnings.push("nothing happened and no gap explains why");
}

// --- report.html ---------------------------------------------------------------------------
const titles = report && !failures.length
  ? ["happened", "happening", "next", "risks", "decisions"].flatMap(k => (report[k] ?? []).map(i => i.title))
  : [];
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const FONT_HOSTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com(\/|$)/;

if (htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  scanLeaks("report.html", html);
  if (!/^\s*<!doctype html>/i.test(html)) fail("html: missing <!doctype html>");
  const lang = html.match(/<html[^>]*\blang="([^"]+)"/i)?.[1];
  if (report && lang !== report.project.language) fail(`html: lang="${lang}" but project.language is ${report.project.language}`);
  const leftover = html.match(/\{\{\{?\s*[#^/]?\s*[\w.]+\s*\}?\}\}/);
  if (leftover) fail(`html: unrendered template tag ${leftover[0]}`);

  // Anything the browser would fetch on its own. Plain <a href> links are navigation, not requests.
  const refs = [];
  for (const m of html.matchAll(/<(\w+)\b[^>]*?\s(src|href|srcset|poster|data|action|formaction|background)\s*=\s*["']?([^"'\s>]+)/gi)) {
    const [, tag, attr, url] = m;
    if (tag.toLowerCase() === "a" && attr.toLowerCase() === "href") continue;
    refs.push({ where: `<${tag} ${attr}>`, url });
  }
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/gi)) {
    refs.push({ where: "CSS", url: m[1] ?? m[2] });
  }
  for (const { where, url } of refs) {
    if (url.startsWith("data:") || url.startsWith("#") || FONT_HOSTS.test(url)) continue;
    fail(`html: ${where} loads ${url.slice(0, 80)}; only data: URIs and Google Fonts are allowed`);
  }
  if (/<base\b|http-equiv\s*=\s*["']?refresh/i.test(html)) fail("html: <base> or meta refresh is not allowed");
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join("\n");
  const net = scripts.match(/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(|\bimport\s*\(/);
  if (net) fail(`html: script uses ${net[1] ?? "import()"}; the report must not reach the network`);

  if (/@keyframes|animation\s*:|transition\s*:/i.test(html) && !/prefers-reduced-motion/i.test(html)) {
    fail("html: has motion but no prefers-reduced-motion rule");
  }
  if (!/@media\s+print/i.test(html)) fail("html: no @media print rules");

  const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  for (const title of titles) if (!markup.includes(escapeHtml(title))) fail(`html: "${title}" is not in the markup without JavaScript`);
  const embedded = html.match(/<script\b[^>]*id=["']report-data["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (embedded != null && report) {
    try {
      if (JSON.stringify(JSON.parse(embedded)) !== JSON.stringify(report)) fail("html: embedded #report-data differs from report.json");
    } catch {
      fail("html: embedded #report-data is not valid JSON");
    }
  }
  if (html.length > 1_000_000) warnings.push(`html is ${Math.round(html.length / 1024)} KB; aim for under 1 MB`);

  if (!flags.has("--no-browser")) await browserPass(htmlPath, titles);
}

// Playwright is third-party code that runs with the user's rights, so it loads only from the install
// the user approved (--playwright-dir=<dir>, its own node_modules and no parent's), never from the
// current directory, which may be the repository being reported on.
function playwrightDir() {
  const flag = args.find(a => a.startsWith("--playwright-dir="));
  return flag ? resolve(flag.slice("--playwright-dir=".length)) : null;
}

async function loadPlaywright() {
  const given = playwrightDir();
  if (!given) return null;
  try {
    const dir = realpathSync(given);
    const require = createRequire(join(dir, "noop.js"));
    const entry = require.resolve("playwright", { paths: [dir] });
    if (!entry.startsWith(join(dir, "node_modules") + sep)) return null;
    const mod = await import(pathToFileURL(entry).href);
    return mod.chromium ? mod : mod.default;
  } catch {
    return null;
  }
}

async function browserPass(file, expectedTitles) {
  const playwright = await loadPlaywright();
  if (!playwright) {
    const msg = "browser pass skipped: no --playwright-dir=<dir> with node_modules/playwright (it is never taken from the current directory)";
    if (flags.has("--require-browser")) fail(msg);
    else console.log(`SKIP ${msg}`);
    return;
  }
  const url = pathToFileURL(resolve(file)).href;
  let browser;
  try {
    browser = await playwright.chromium.launch();
  } catch (error) {
    const msg = `browser pass skipped: Chromium did not start (${error.message.split("\n")[0]})`;
    if (flags.has("--require-browser")) fail(msg);
    else console.log(`SKIP ${msg}`);
    return;
  }
  try {
    const runs = [];
    for (const width of [1280, 390]) for (const js of [false, true]) runs.push({ width, js, motion: "no-preference" });
    runs.push({ width: 1280, js: true, motion: "reduce" });
    for (const { width, js, motion } of runs) {
      const run = `${width}px ${js ? "JS" : "no JS"}${motion === "reduce" ? " reduced motion" : ""}`;
      const context = await browser.newContext({ viewport: { width, height: 900 }, javaScriptEnabled: js, reducedMotion: motion });
      const page = await context.newPage();
      const errors = [];
      const requests = [];
      page.on("pageerror", e => errors.push(e.message));
      page.on("request", r => {
        const u = r.url();
        if (!u.startsWith("file:") && !u.startsWith("data:") && !FONT_HOSTS.test(u)) requests.push(u);
      });
      await page.goto(url, { waitUntil: "load" });
      if (js) {
        await page.evaluate(async () => {
          for (let y = 0; y <= document.body.scrollHeight; y += 300) {
            window.scrollTo({ top: y, behavior: "instant" });
            await new Promise(done => setTimeout(done, 60));
          }
          window.scrollTo({ top: 0, behavior: "instant" });
        });
        await page.waitForTimeout(1500);
      }
      const r = await page.evaluate(titles => {
        const doc = document.documentElement;
        const text = document.body.innerText;
        return {
          overflow: Math.max(doc.scrollWidth, document.body.scrollWidth) - doc.clientWidth,
          missing: titles.filter(t => !text.includes(t)),
          endless: document.getAnimations?.().filter(a => a.playState === "running" && a.effect?.getTiming().iterations === Infinity).length ?? 0,
        };
      }, expectedTitles);
      if (r.overflow > 0) fail(`${run}: horizontal overflow ${r.overflow}px`);
      if (r.missing.length) fail(`${run}: not visible: ${r.missing.slice(0, 3).join(" | ")}${r.missing.length > 3 ? " …" : ""}`);
      if (motion === "reduce" && r.endless) fail(`${run}: ${r.endless} endless animations still run`);
      if (errors.length) fail(`${run}: page errors: ${errors.join(" | ")}`);
      if (requests.length) fail(`${run}: network requests: ${requests.slice(0, 3).join(" | ")}`);
      console.log(`${run}: overflow ${r.overflow}px, ${errors.length} errors, ${requests.length} requests`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

for (const w of warnings) console.log(`WARN ${w}`);
if (failures.length) {
  console.error(`\nFAIL (${failures.length})\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nPASS: ${htmlPath ? "report.json and report.html" : "report.json"}`);
