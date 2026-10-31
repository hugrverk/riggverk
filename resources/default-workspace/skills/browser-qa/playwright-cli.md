# Playwright CLI route

For sessions with no browser tool. It needs Node.js and a shell. Both downloads below (the `playwright` package and a browser binary) need the user's approval first; say what and why, then wait.

1. **Workspace.** Make a fresh directory outside the repository (`mktemp -d`), call it `$T`, and write absolute paths into each command, since shell variables may not survive between tool calls. Keep the dependency out of the project.
2. **Install, once per run.** `cd "$T" && npm init -y >/dev/null && npm i playwright` then `npx playwright install chromium`. If either is refused or fails, report browser QA as not run and stop.
3. **Script.** Save as `$T/smoke.cjs` and run `node "$T/smoke.cjs" <url> [WIDTHxHEIGHT ...]`. It loads the page once per viewport (default `1280x800` and `390x844`), prints console errors, page errors, failed requests and HTTP 4xx/5xx, and saves a full-page screenshot per viewport next to the script.

```js
const { chromium } = require("playwright");
const out = __dirname;
const strip = (u) => u.split("?")[0];
(async () => {
  const [url, ...sizes] = process.argv.slice(2);
  const browser = await chromium.launch();
  for (const size of sizes.length ? sizes : ["1280x800", "390x844"]) {
    const [width, height] = size.split("x").map(Number);
    const page = await browser.newPage({ viewport: { width, height } });
    page.on("console", (m) => m.type() === "error" && console.log(`console.error [${size}] ${m.text().slice(0, 300)}`));
    page.on("pageerror", (e) => console.log(`pageerror [${size}] ${String(e.message).slice(0, 300)}`));
    page.on("requestfailed", (r) => console.log(`requestfailed [${size}] ${strip(r.url())} ${r.failure()?.errorText}`));
    page.on("response", (r) => r.status() >= 400 && console.log(`http ${r.status()} [${size}] ${strip(r.url())}`));
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page.screenshot({ path: `${out}/${size}.png`, fullPage: true });
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error(String(e.message).slice(0, 500)); process.exit(1); });
```

4. **Interactions.** For a click, a form or a keyboard path, add the steps after `page.goto` (`page.getByRole(...).click()`, `page.keyboard.press("Tab")`) and print what you assert.
5. **Report.** Same as the Output section above, naming "Playwright CLI" as the tool. The script reads only the URL you pass, with query strings left out of its output; do not paste tokens into the URL. Delete `$T` when done.

Plain CLI options also work for a quick visual check: `npx playwright screenshot --viewport-size=390,844 <url> <file>`. Check any flag with `npx playwright <command> --help`, since options differ between versions.
