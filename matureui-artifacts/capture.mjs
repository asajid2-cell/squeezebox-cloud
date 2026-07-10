// Screenshot capture for mature-ui before/after.
// Usage: node capture.mjs <outDir>  (e.g. before or after)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'z:/328/CMPUT328-A2/codexworks/301/tandem/node_modules/playwright');

const OUT = process.argv[2] || 'before';
const BASE = 'http://127.0.0.1:5177';
const ADMIN_PW = 'matureui-admin-2026';
const dir = `Z:/328/CMPUT328-A2/codexworks/301/cloud-squeeze-matureui-v3/matureui-artifacts/${OUT}`;

const DESK = { width: 1440, height: 900 };
const NARROW = { width: 430, height: 900 };

async function shoot(page, name) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
  console.log('shot', name);
}

async function clickNav(page, label) {
  await page.getByRole('button', { name: label, exact: false }).first().click().catch(() => {});
  await page.waitForTimeout(500);
}

const browser = await chromium.launch();

// ---- desktop public screens ----
const ctx = await browser.newContext({ viewport: DESK });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(1200);
await shoot(page, 'desk-01-nowplaying');

for (const [nav, file] of [['Queue','desk-02-queue'],['Playlists','desk-03-playlists'],['Library','desk-04-library'],['Archive','desk-05-archive']]) {
  await page.getByRole('button', { name: nav, exact: false }).first().click().catch(()=>{});
  await page.waitForTimeout(900);
  await shoot(page, file);
}

// Library local tab (VPS library) to show result rows
await page.getByRole('button', { name: 'Library', exact: false }).first().click().catch(()=>{});
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'VPS library', exact: false }).first().click().catch(()=>{});
await page.waitForTimeout(900);
await shoot(page, 'desk-06-library-local');

// Playlists -> My Playlists
await page.getByRole('button', { name: 'Playlists', exact: false }).first().click().catch(()=>{});
await page.waitForTimeout(600);
await shoot(page, 'desk-07-playlists-mine');

await ctx.close();

// ---- admin ----
const actx = await browser.newContext({ viewport: DESK });
const apage = await actx.newPage();
await apage.goto(`${BASE}/admin`, { waitUntil: 'networkidle' }).catch(()=>{});
await apage.waitForTimeout(1000);
await shoot(apage, 'desk-08-admin-login');
await apage.getByLabel('Admin password').fill(ADMIN_PW).catch(()=>{});
await apage.getByRole('button', { name: 'Log in', exact: false }).first().click().catch(()=>{});
await apage.waitForTimeout(1500);
await shoot(apage, 'desk-09-admin-console');
await actx.close();

// ---- narrow (mobile form) ----
const nctx = await browser.newContext({ viewport: NARROW });
const npage = await nctx.newPage();
await npage.goto(BASE, { waitUntil: 'networkidle' }).catch(()=>{});
await npage.waitForTimeout(1200);
await shoot(npage, 'narrow-01-nowplaying');
await npage.getByRole('button', { name: 'Library', exact: false }).first().click().catch(()=>{});
await npage.waitForTimeout(900);
await shoot(npage, 'narrow-02-library');
await nctx.close();

await browser.close();
console.log('done');
