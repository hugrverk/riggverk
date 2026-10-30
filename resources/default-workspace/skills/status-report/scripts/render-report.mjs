#!/usr/bin/env node
// Renders report.json into one self-contained HTML file. Node 18+, no dependencies.
//   node render-report.mjs <report.json> [--template <file.html>] [--out <file.html>]
// The template is HTML with a small Mustache subset:
//   {{a.b}}             HTML-escaped value ("" when missing); {{.}} is the current item
//   {{#name}}…{{/name}} once per item of a non-empty array, or once when the value is truthy
//   {{^name}}…{{/name}} only when the value is missing, false, 0, "" or an empty array
//   {{{json}}}          the report as JSON that is safe inside <script type="application/json">
// The renderer adds derived, localised fields (labels, dates, numbers, sparkline paths, ids) so
// the template needs no logic. All content lands in the markup; template JavaScript only enhances.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAW_ALLOWED = new Set(["json"]);

// Template labels. A language without an entry gets English labels around the report's own copy.
const STRINGS = {
  en: {
    report: "Status report", generated: "Generated", about: "About the project", figures: "Figures",
    spread: "Happened, in progress, next", lower: "Risks and decisions",
    happened: "Happened", happening: "In progress", next: "Next", risks: "Risks", decisions: "Decisions",
    gaps: "Not checked", sources: "Sources", items: "items", empty: "Nothing to report.",
    c_happened: "happened", c_happening: "in progress", c_next: "next", c_risks: "risks",
    source: "Source:", claimed: "stated", claimed_source: "(stated)", mitigation: "Mitigation:",
    depends_on: "Depends on", no_deps: "No known dependencies.", undated: "undated",
    confidence: "Confidence:", progress: "Progress", done: "done",
    health: { "on-track": "Status: on track", "at-risk": "Status: at risk", blocked: "Status: blocked" },
    status: { active: "Active", review: "In review", blocked: "Blocked" },
    kind: { release: "Release", feature: "Feature", fix: "Fix", security: "Security", docs: "Docs", decision: "Decision", chore: "Maintenance" },
    severity: { high: "High", medium: "Medium", low: "Low" },
    conf: { high: "high", medium: "medium", low: "low" },
  },
  sv: {
    report: "Lägesrapport", generated: "Genererad", about: "Om projektet", figures: "Siffror",
    spread: "Hänt, pågår, nästa", lower: "Risker och beslut",
    happened: "Hänt", happening: "Pågår", next: "Nästa", risks: "Risker", decisions: "Beslut",
    gaps: "Ej kontrollerat", sources: "Källor", items: "poster", empty: "Inget att rapportera.",
    c_happened: "hänt", c_happening: "pågår", c_next: "nästa", c_risks: "risker",
    source: "Källa:", claimed: "uppgivet", claimed_source: "(uppgivet)", mitigation: "Åtgärd:",
    depends_on: "Beror på", no_deps: "Inga kända beroenden.", undated: "odaterat",
    confidence: "Säkerhet:", progress: "Framsteg", done: "klart",
    health: { "on-track": "Läget: på spår", "at-risk": "Läget: i riskzonen", blocked: "Läget: blockerat" },
    status: { active: "Pågår", review: "Granskas", blocked: "Blockerat" },
    kind: { release: "Release", feature: "Funktion", fix: "Fix", security: "Säkerhet", docs: "Dokumentation", decision: "Beslut", chore: "Underhåll" },
    severity: { high: "Hög", medium: "Medel", low: "Låg" },
    conf: { high: "hög", medium: "medel", low: "låg" },
  },
};

function parseArgs(argv) {
  const args = { input: null, template: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--template") args.template = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (!args.input) args.input = argv[i];
    else throw new Error(`unexpected argument ${argv[i]}`);
  }
  if (!args.input) throw new Error("usage: node render-report.mjs <report.json> [--template <file>] [--out <file>]");
  return args;
}

const escapeHtml = value =>
  String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// JSON for a <script type="application/json"> block: no "</script", "<!--" or line separators can escape it.
const scriptSafeJson = data =>
  JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

// --- Mustache subset ------------------------------------------------------------------------
function parseTemplate(source) {
  const re = /\{\{(\{)?\s*([#^/]?)\s*([\w.]+|\.)\s*(\})?\}\}/g;
  const root = { children: [] };
  const stack = [root];
  let last = 0;
  for (let m; (m = re.exec(source)); ) {
    const [whole, rawOpen, sigil, name, rawClose] = m;
    const top = stack[stack.length - 1];
    if (m.index > last) top.children.push({ text: source.slice(last, m.index) });
    last = m.index + whole.length;
    if (Boolean(rawOpen) !== Boolean(rawClose)) throw new Error(`malformed tag ${whole}`);
    if (rawOpen) {
      if (!RAW_ALLOWED.has(name)) throw new Error(`unescaped output is only allowed for ${[...RAW_ALLOWED]}: ${whole}`);
      top.children.push({ raw: name });
    } else if (sigil === "#" || sigil === "^") {
      const node = { section: name, inverted: sigil === "^", children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (sigil === "/") {
      if (top.section !== name) throw new Error(`{{/${name}}} closes {{#${top.section ?? "nothing"}}}`);
      stack.pop();
    } else top.children.push({ name });
  }
  if (stack.length > 1) throw new Error(`unclosed section {{#${stack[stack.length - 1].section}}}`);
  if (last < source.length) root.children.push({ text: source.slice(last) });
  return root;
}

function lookup(stack, name) {
  if (name === ".") return stack[stack.length - 1];
  const [head, ...rest] = name.split(".");
  for (let i = stack.length - 1; i >= 0; i--) {
    const ctx = stack[i];
    if (ctx && typeof ctx === "object" && Object.hasOwn(ctx, head)) {
      return rest.reduce((v, key) => (v == null ? undefined : v[key]), ctx[head]);
    }
  }
  return undefined;
}

function renderNodes(nodes, stack) {
  let out = "";
  for (const node of nodes) {
    if ("text" in node) out += node.text;
    else if ("raw" in node) out += lookup(stack, node.raw) ?? "";
    else if ("name" in node) {
      const v = lookup(stack, node.name);
      out += v == null || v === false ? "" : escapeHtml(v);
    } else {
      const v = lookup(stack, node.section);
      const empty = v == null || v === false || v === "" || v === 0 || (Array.isArray(v) && v.length === 0);
      if (node.inverted) out += empty ? renderNodes(node.children, stack) : "";
      else if (!empty) {
        // Primitives are pushed too so {{.}} works; lookups skip them and fall through to the parent.
        for (const item of Array.isArray(v) ? v : [v]) out += renderNodes(node.children, [...stack, item]);
      }
    }
  }
  return out;
}

// --- View model -----------------------------------------------------------------------------
function viewModel(report) {
  const lang = report.project.language;
  const t = STRINGS[lang.slice(0, 2)] ?? STRINGS.en;
  // Dates are calendar dates in the report's own time zone, so format them as UTC wall time.
  const utc = iso => new Date(`${iso}T00:00:00Z`);
  const fmt = (opts, d) => new Intl.DateTimeFormat(lang, { timeZone: "UTC", ...opts }).format(d).replace(/\.(?=\s|$)/g, "");
  const short = iso => fmt({ day: "numeric", month: "short" }, utc(iso));
  const long = iso => fmt({ day: "numeric", month: "long", year: "numeric" }, utc(iso));
  const stamp = iso => (iso.length > 10 ? `${short(iso.slice(0, 10))} ${iso.slice(11, 16)}` : long(iso));
  const whenLabel = when => {
    if (!when) return t.undated;
    if (/^\d{4}$/.test(when)) return when;
    const q = when.match(/^(\d{4})-Q([1-4])$/);
    if (q) return `Q${q[2]} ${q[1]}`;
    if (/^\d{4}-\d{2}$/.test(when)) return fmt({ month: "short", year: "numeric" }, utc(`${when}-01`));
    return short(when);
  };
  const number = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 });
  const byId = Object.fromEntries(report.sources.map(s => [s.id, s]));
  const cited = (item, prefix, i) => ({
    ...item,
    uid: `${prefix}${i + 1}`,
    claimed: item.cite.every(id => byId[id]?.kind === "stated"),
    cite_text: item.cite.map(id => byId[id]?.label ?? id).join(" · "),
  });
  const spark = trend => {
    if (!trend || trend.length < 2) return undefined;
    const [W, H] = [64, 26];
    const max = Math.max(...trend, 1);
    const min = Math.min(...trend, 0);
    const pts = trend.map((v, i) => [(i / (trend.length - 1)) * W, H - 2 - ((v - min) / (max - min || 1)) * (H - 4)]);
    const [x, y] = pts.at(-1);
    return { d: pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" "), x: x.toFixed(1), y: y.toFixed(1) };
  };
  const list = key => report[key] ?? [];

  return {
    ...report,
    lang,
    t,
    json: scriptSafeJson(report),
    generated_label: stamp(report.generated),
    period_range: `${short(report.period.from)} – ${long(report.period.to)}`,
    period_to_short: short(report.period.to),
    health: { ...cited(report.health, "health", 0), state_label: t.health[report.health.state] },
    metrics: list("metrics").map((m, i) => ({ ...cited(m, "m", i), index: i, value_label: number.format(m.value), spark: spark(m.trend) })),
    happened: list("happened").map((h, i) => ({ ...cited(h, "h", i), date_label: short(h.date), kind_label: t.kind[h.kind] })),
    happening: list("happening").map((h, i) => ({
      ...cited(h, "w", i),
      status_label: t.status[h.status],
      byline: [h.owner, h.ref].filter(Boolean).join(" · "),
      progress_pct: h.progress == null ? undefined : Math.round(h.progress * 100),
    })),
    next: list("next").map((n, i) => ({
      ...cited(n, "n", i),
      when_label: whenLabel(n.when),
      confidence_label: t.conf[n.confidence],
      deps_text: (n.depends_on ?? []).join(", "),
    })),
    risks: list("risks").map((r, i) => ({ ...cited(r, "r", i), severity_label: t.severity[r.severity] })),
    decisions: list("decisions").map((d, i) => ({ ...cited(d, "d", i), date_label: short(d.date) })),
    has_lower: list("risks").length + list("decisions").length > 0,
    gaps: list("gaps"),
    sources: report.sources.map(s => ({ ...s, stated: s.kind === "stated", at_label: stamp(s.at) })),
    counts: Object.fromEntries(["happened", "happening", "next", "risks", "decisions"].map(k => [k, String(list(k).length)])),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const templatePath = resolve(args.template ?? join(here, "..", "assets", "report-template.html"));
  const report = JSON.parse(readFileSync(args.input, "utf8"));
  if (!report?.project?.language || !Array.isArray(report.sources) || !report.health?.cite) {
    throw new Error("report.json does not follow report.schema.json; run verify-report.mjs on it first");
  }
  const html = renderNodes(parseTemplate(readFileSync(templatePath, "utf8")).children, [viewModel(report)]);
  const slug = report.project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  const out = resolve(args.out ?? join(dirname(resolve(args.input)), `${slug}-status-${report.period.to}.html`));
  writeFileSync(out, html);
  console.log(`wrote ${out} (${Buffer.byteLength(html)} bytes) from ${basename(templatePath)}`);
}

try {
  main();
} catch (error) {
  console.error(`render-report: ${error.message}`);
  process.exit(1);
}
