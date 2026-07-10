// Hostile-content probe: long unbroken strings in search + result rows at the
// narrowest battery viewport; checks for horizontal page overflow.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'z:/328/CMPUT328-A2/codexworks/301/tandem/node_modules/playwright');

const LONG = 'Donaudampfschifffahrtsgesellschaftskapitaenswitwenrentenauszahlungsstelle2026';
const browser = await chromium.launch();

for (const vp of [{ w: 320, h: 568 }, { w: 390, h: 844 }, { w: 1366, h: 768 }]) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  await page.goto('http://127.0.0.1:5177/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  // type the long unbroken string into search (switch to VPS results view)
  await page.locator('.sidebar-search input').fill(LONG);
  await page.waitForTimeout(800);
  const over1 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  // library rows with real long titles
  await page.locator('.source-tabs button').nth(1).click().catch(() => {});
  await page.locator('.sidebar-search input').fill('a');
  await page.waitForTimeout(900);
  const over2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log(`${vp.w}x${vp.h}: overflow(searchLong)=${over1}px overflow(rows)=${over2}px ${over1 <= 1 && over2 <= 1 ? 'OK' : 'FAIL'}`);
  await page.close();
}
await browser.close();
