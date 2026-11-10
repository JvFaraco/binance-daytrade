// Abre o painel no Chromium, espera os dados reais chegarem e salva screenshots.
//   node tools/shot.mjs [url] [dir] [espera_ms]
// Usado para a verificação visual (1440 px e 390 px) antes de cada entrega.
// (CommonJS de propósito: o Playwright deste ambiente é global e só resolve com require.)
const { chromium, devices } = require("playwright");
const { mkdirSync } = require("node:fs");

const url = process.argv[2] ?? "http://localhost:5173/binance-daytrade/";
const dir = process.argv[3] ?? "shots";
const wait = Number(process.argv[4] ?? 15000);
const only = process.argv[5];
mkdirSync(dir, { recursive: true });

const targets = [
  { name: "desktop-1440", ctx: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
  { name: "tablet-1024", ctx: { viewport: { width: 1024, height: 900 }, deviceScaleFactor: 1 } },
  { name: "mobile-390", ctx: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } } },
].filter((t) => !only || t.name.startsWith(only));

(async () => {
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
for (const t of targets) {
  const context = await browser.newContext(t.ctx);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(wait);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.screenshot({ path: `${dir}/${t.name}.png`, fullPage: true });
  console.log(`${t.name}: scroll horizontal = ${overflow}px; erros de console = ${errors.length}`);
  for (const e of errors.slice(0, 8)) console.log("   ", e.slice(0, 300));
  await context.close();
}
await browser.close();
})();
