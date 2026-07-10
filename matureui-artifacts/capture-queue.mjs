// Extra proof captures: populated Queue (64px rows, drag handles, duration context)
// + the open row kebab (reorder group + divider + destructive Remove).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'z:/328/CMPUT328-A2/codexworks/301/tandem/node_modules/playwright');
const dir = 'Z:/328/CMPUT328-A2/codexworks/301/cloud-squeeze-matureui-v3/matureui-artifacts/current';
const BASE = 'http://127.0.0.1:5177';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'networkidle' }).catch(()=>{});
await page.waitForTimeout(1200);
await page.getByRole('button', { name: 'Queue', exact: false }).first().click().catch(()=>{});
await page.waitForTimeout(1000);
await page.screenshot({ path: `${dir}/desk-02-queue.png`, fullPage: true });
console.log('shot desk-02-queue (populated)');

// open the first queue row's kebab to prove the grouped + divided destructive menu
const kebab = page.getByRole('button', { name: /Queue actions for/ }).first();
await kebab.click().catch(()=>{});
await page.waitForTimeout(500);
await page.screenshot({ path: `${dir}/desk-02b-queue-menu.png`, fullPage: false });
console.log('shot desk-02b-queue-menu');
await ctx.close();
await browser.close();
console.log('done');
