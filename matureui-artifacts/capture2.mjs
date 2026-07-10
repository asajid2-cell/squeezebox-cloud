// Screenshot capture for mature-ui. Usage: node capture2.mjs <outDir>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'z:/328/CMPUT328-A2/codexworks/301/tandem/node_modules/playwright');

const OUT = process.argv[2] || 'current';
const BASE = 'http://127.0.0.1:5177';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'QFJ2aIWYxumSPhsZ8N3g';
const dir = `Z:/328/CMPUT328-A2/codexworks/301/cloud-squeeze-matureui-v3/matureui-artifacts/${OUT}`;
import { mkdirSync } from 'node:fs';
mkdirSync(dir, { recursive: true });

const DESK = { width: 1440, height: 900 };
const NARROW = { width: 430, height: 900 };

async function shoot(page, name, full = true) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: full });
  console.log('shot', name);
}
async function nav(page, label) {
  await page.getByRole('button', { name: label, exact: false }).first().click().catch(()=>{});
  await page.waitForTimeout(900);
}

const browser = await chromium.launch();

// desktop
const ctx = await browser.newContext({ viewport: DESK });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'networkidle' }).catch(()=>{});
await page.waitForTimeout(1400);
await shoot(page, 'desk-01-nowplaying');
for (const [n, f] of [['Queue','desk-02-queue'],['Playlists','desk-03-playlists'],['Library','desk-04-library'],['Archive','desk-05-archive']]) {
  await nav(page, n); await shoot(page, f);
}
await nav(page, 'Library');
await page.getByRole('button', { name: 'VPS library', exact: false }).first().click().catch(()=>{});
await page.waitForTimeout(900);
await shoot(page, 'desk-06-library-local');
await ctx.close();

// admin
const actx = await browser.newContext({ viewport: DESK });
const apage = await actx.newPage();
await apage.goto(`${BASE}/admin`, { waitUntil: 'networkidle' }).catch(()=>{});
await apage.waitForTimeout(1000);
await shoot(apage, 'desk-08-admin-login');
const pw = apage.locator('input[type="password"]').first();
await pw.click().catch(()=>{});
await pw.fill(ADMIN_PW).catch(()=>{});
await apage.waitForTimeout(300);
await apage.getByRole('button', { name: /log in/i }).first().click().catch(()=>{});
await apage.waitForTimeout(400);
await pw.press('Enter').catch(()=>{});
await apage.waitForTimeout(2600);
await shoot(apage, 'desk-09-admin-console');
await actx.close();

// narrow
const nctx = await browser.newContext({ viewport: NARROW });
const npage = await nctx.newPage();
await npage.goto(BASE, { waitUntil: 'networkidle' }).catch(()=>{});
await npage.waitForTimeout(1400);
await shoot(npage, 'narrow-01-nowplaying');
await npage.getByRole('button', { name: 'Library', exact: false }).first().click().catch(()=>{});
await npage.waitForTimeout(900);
await shoot(npage, 'narrow-02-library');
await npage.getByRole('button', { name: 'Queue', exact: false }).first().click().catch(()=>{});
await npage.waitForTimeout(900);
await shoot(npage, 'narrow-03-queue');
await nctx.close();

await browser.close();
console.log('done');
