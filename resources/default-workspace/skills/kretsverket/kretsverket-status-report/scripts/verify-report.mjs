#!/usr/bin/env node
// Verifies a Kretsverket lägesrapport at 1280 and 390 px, each without and with JavaScript.
// Run it from inside the Kretsverket checkout (copy it next to the report) so `playwright`
// resolves from Kretsverket's node_modules:
//   node .agent-reports/rapport/verify-report.mjs .agent-reports/rapport/<report>.html
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const file = process.argv[2];
if (!file) {
  console.error("usage: node verify-report.mjs <report.html>");
  process.exit(2);
}
const url = pathToFileURL(resolve(file)).href;
const SECTIONS = ["oversikt", "pa-plats", "kvar", "release", "beslut", "agent", "nu"];

// Everything the report must satisfy, read from the rendered page.
function inspect(sections) {
  const doc = document.documentElement;
  const num = text => parseFloat(text.replace(/[\s  ]/g, "").replace(",", "."));
  const found = sections.map(id => document.getElementById(id));
  const present = found.filter(Boolean);
  const gaugeVal = document.getElementById("gaugeVal");
  const gaugeNum = document.getElementById("gaugeNum");
  const gaugeLabel = gaugeVal?.closest("svg")?.getAttribute("aria-label") ?? "";
  const filterCounts = (attr, items, key) =>
    [...document.querySelectorAll(`[${attr}]`)]
      .filter(el => {
        const value = el.getAttribute(attr);
        const expected = value === "all" ? items.length : items.filter(i => i.dataset[key] === value).length;
        return num(el.textContent) !== expected;
      })
      .map(el => el.getAttribute(attr));
  const areas = [...document.querySelectorAll("#areas [data-s]")];
  const decisions = [...document.querySelectorAll("#decisions [data-b]")];
  return {
    js: doc.classList.contains("js"),
    overflow: Math.max(doc.scrollWidth, document.body.scrollWidth) - doc.clientWidth,
    missingSections: sections.filter((_, i) => !found[i]),
    sectionsInOrder: present.every(
      (el, i) => i === 0 || present[i - 1].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
    ),
    hiddenReveals: [...document.querySelectorAll(".reveal")].filter(el => getComputedStyle(el).opacity === "0").length,
    counters: [...document.querySelectorAll("[data-count]")].map(el => ({
      text: el.textContent.trim(),
      final: num(el.textContent) === parseFloat(el.dataset.count),
    })),
    emptyBars: [...document.querySelectorAll(".bar > i")].filter(i => i.getBoundingClientRect().width === 0).length,
    gauge: gaugeNum ? num(gaugeNum.textContent) : null,
    gaugeArc: gaugeVal ? Math.round(100 * (1 - parseFloat(getComputedStyle(gaugeVal).strokeDashoffset) / 515.2)) : null,
    gaugeLabel,
    badFilterCounts: [...filterCounts("data-c", areas, "s"), ...filterCounts("data-dc", decisions, "b")],
  };
}

const browser = await chromium.launch();
const failures = [];
const gaugeByRun = {};
for (const width of [1280, 390]) {
  for (const javaScriptEnabled of [false, true]) {
    const run = `${width}px ${javaScriptEnabled ? "with JS" : "no JS"}`;
    const context = await browser.newContext({ viewport: { width, height: 900 }, javaScriptEnabled });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(url, { waitUntil: "load" });
    if (javaScriptEnabled) {
      // Scroll through so every reveal, counter and bar starts, then let them finish. The report sets
      // `scroll-behavior: smooth`, so jump instantly or the observer never sees the lower sections.
      await page.evaluate(async () => {
        for (let y = 0; y <= document.body.scrollHeight; y += 300) {
          window.scrollTo({ top: y, behavior: "instant" });
          await new Promise(done => setTimeout(done, 80));
        }
        window.scrollTo({ top: 0, behavior: "instant" });
      });
      await page.waitForTimeout(2500);
    }
    const r = await page.evaluate(inspect, SECTIONS);
    const fail = message => failures.push(`${run}: ${message}`);
    if (r.js !== javaScriptEnabled) fail(`html.js is ${r.js}, expected ${javaScriptEnabled}`);
    if (r.overflow !== 0) fail(`horizontal overflow ${r.overflow}px`);
    if (r.missingSections.length) fail(`missing sections ${r.missingSections.join(", ")}`);
    if (!r.sectionsInOrder) fail("sections out of order");
    if (r.hiddenReveals) fail(`${r.hiddenReveals} hidden .reveal blocks`);
    const notFinal = r.counters.filter(c => !c.final).map(c => c.text);
    if (notFinal.length) fail(`counters not at their data-count value: ${notFinal.join(" | ")}`);
    if (r.emptyBars) fail(`${r.emptyBars} empty progress bars`);
    if (r.gauge === null) fail("gauge number missing");
    else {
      if (Math.abs(r.gauge - r.gaugeArc) > 1) fail(`gauge shows ${r.gauge} but its arc is ${r.gaugeArc}`);
      if (!r.gaugeLabel.includes(String(r.gauge))) fail(`gauge aria-label does not mention ${r.gauge}`);
    }
    if (r.badFilterCounts.length) fail(`filter counts do not match the cards: ${r.badFilterCounts.join(", ")}`);
    if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
    gaugeByRun[run] = r.gauge;
    console.log(`${run}: overflow ${r.overflow}px, ${r.counters.length} counters, gauge ${r.gauge}, ${errors.length} page errors`);
    await context.close();
  }
}
await browser.close();

// The script's GAUGE constant must land on the same number the markup shows without JS.
if (new Set(Object.values(gaugeByRun)).size > 1) failures.push(`gauge differs between runs: ${JSON.stringify(gaugeByRun)}`);

if (failures.length) {
  console.error(`\nFAIL (${failures.length})\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nPASS: all four runs");
