import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] || "before";
const BASE = "http://127.0.0.1:5177";
const dir = new URL(`./${OUT}/`, import.meta.url);
mkdirSync(dir, { recursive: true });

const desktop = { width: 1440, height: 900 };
const mobile = { width: 390, height: 844 };

async function shot(page, name) {
  await page.screenshot({ path: new URL(name, dir).pathname.replace(/^\//, "") });
  console.log("shot", name);
}
async function clickNav(page, label) {
  await page.getByRole("button", { name: new RegExp(`^${label}`, "i") }).first().click().catch(() => {});
  await page.waitForTimeout(900);
}
async function clickTab(page, name) {
  await page.getByRole("button", { name, exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1400);
}

async function seedQueue() {
  // Add a few local tracks to the shared queue via the public request API.
  const res = await fetch(`${BASE}/api/library/search?q=&limit=6&source=local`);
  const { results = [] } = await res.json();
  for (const t of results.slice(0, 6)) {
    await fetch(`${BASE}/api/player/track`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "add-queue", track: t })
    }).catch(() => {});
  }
}

async function run() {
  await seedQueue().catch(() => {});
  const browser = await chromium.launch();

  // ---- Desktop ----
  const ctx = await browser.newContext({ viewport: desktop, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await shot(page, "d-now-playing.png");

  await clickNav(page, "Queue");
  await shot(page, "d-queue.png");

  await clickNav(page, "Library");
  await clickTab(page, "VPS library");
  await shot(page, "d-library-local.png");
  // open a row overflow menu
  await page.getByRole("button", { name: /More actions/i }).first().click().catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, "d-library-rowmenu.png");
  await page.keyboard.press("Escape").catch(() => {});

  await clickNav(page, "Playlists");
  await shot(page, "d-playlists.png");

  await clickNav(page, "Archive");
  await shot(page, "d-archive.png");

  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await shot(page, "d-admin-login.png");
  await ctx.close();

  // ---- Mobile ----
  const mctx = await browser.newContext({ viewport: mobile, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mpage = await mctx.newPage();
  await mpage.goto(BASE, { waitUntil: "networkidle" });
  await mpage.waitForTimeout(1500);
  await shot(mpage, "m-now-playing.png");
  await clickNav(mpage, "Library");
  await clickTab(mpage, "VPS library");
  await shot(mpage, "m-library.png");
  await mctx.close();

  await browser.close();
}
run().then(() => console.log("done")).catch((e) => { console.error(e); process.exit(1); });
