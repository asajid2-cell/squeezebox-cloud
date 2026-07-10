import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SHOT_BASE || "http://127.0.0.1:5179";
const PHASE = process.env.SHOT_PHASE || "before";
const outDir = path.join(__dirname, PHASE);
const ADMIN_PW = "matureui-test-pass";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(page, name) {
  await wait(500);
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
  console.log("shot", name);
}

async function clickNav(page, label) {
  await page.getByRole("button", { name: label, exact: false }).first().click().catch(() => {});
  await wait(700);
}

async function run() {
  const browser = await chromium.launch();

  // ---------- DESKTOP ----------
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await wait(1200);
  await shoot(page, "d-nowplaying");

  // Library - default is Spotify (not linked)
  await clickNav(page, "Library");
  await shoot(page, "d-library-spotify");

  // Library - VPS library tab (populated)
  await page.getByRole("button", { name: "Local", exact: true }).first().click().catch(() => {});
  await wait(900);
  await shoot(page, "d-library-vps");

  // Library - active query on VPS
  const search = page.getByPlaceholder("Search...");
  await search.click();
  await search.fill("juice");
  await wait(1100);
  await shoot(page, "d-library-vps-query");

  // hover a result row to prove the row-interaction model (actions reveal on hover)
  const firstRow = page.locator(".result-row").first();
  await firstRow.hover().catch(() => {});
  await wait(400);
  await shoot(page, "d-library-vps-hover");

  // no-results query
  await search.fill("zzznoresultsxyz");
  await wait(1100);
  await shoot(page, "d-library-noresults");
  await search.fill("");
  await wait(400);

  // Queue
  await clickNav(page, "Queue");
  await shoot(page, "d-queue");

  // Playlists
  await clickNav(page, "Playlists");
  await shoot(page, "d-playlists-mine");
  await page.getByRole("button", { name: "Local", exact: true }).click().catch(() => {});
  await wait(900);
  await shoot(page, "d-playlists-local");
  // open a collection
  await page.locator(".collection-row").first().click().catch(() => {});
  await wait(1200);
  await shoot(page, "d-playlists-detail");

  // Archive
  await clickNav(page, "Archive");
  await shoot(page, "d-archive");

  // Admin login
  await page.goto(BASE + "admin".replace(/^/, "/"), { waitUntil: "networkidle" }).catch(async () => {
    await page.goto(BASE.replace(/\/$/, "") + "/admin", { waitUntil: "networkidle" });
  });
  await wait(900);
  await shoot(page, "d-admin-login");
  // login
  await page.getByLabel("Admin password").fill(ADMIN_PW).catch(() => {});
  await page.getByRole("button", { name: "Log in" }).click().catch(() => {});
  await wait(1400);
  await shoot(page, "d-admin-console");

  await ctx.close();

  // ---------- MOBILE ----------
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mp = await mctx.newPage();
  await mp.goto(BASE, { waitUntil: "networkidle" });
  await wait(1200);
  await shoot(mp, "m-nowplaying");
  await mp.getByRole("button", { name: "Library", exact: false }).first().click().catch(() => {});
  await wait(700);
  await mp.getByRole("button", { name: "Local", exact: true }).first().click().catch(() => {});
  await wait(900);
  await shoot(mp, "m-library-vps");
  await mp.getByRole("button", { name: "Queue", exact: false }).first().click().catch(() => {});
  await wait(700);
  await shoot(mp, "m-queue");
  await mctx.close();

  await browser.close();
  console.log("DONE");
}

run().catch((e) => { console.error(e); process.exit(1); });
