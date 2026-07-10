// Keyboard pass: tab order, visible focus, Escape closing overlays, no traps.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'z:/328/CMPUT328-A2/codexworks/301/tandem/node_modules/playwright');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:5177/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

const active = () => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return 'body';
  const label = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 30) || el.tagName;
  const outline = getComputedStyle(el, ':focus-visible');
  return `${el.tagName.toLowerCase()}[${label}]`;
});

console.log('--- Tab order (first 14 stops) ---');
for (let i = 0; i < 14; i++) {
  await page.keyboard.press('Tab');
  console.log(`${i + 1}: ${await active()}`);
}

console.log('--- focus outline present? ---');
const outline = await page.evaluate(() => {
  const el = document.activeElement;
  const s = getComputedStyle(el);
  return `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`;
});
console.log('outline on focused el:', outline);

// Open a row menu with keyboard: go to Library > VPS rows, open first row menu via click, Escape closes.
await page.getByRole('button', { name: 'Library', exact: true }).click();
await page.waitForTimeout(400);
await page.locator('.source-tabs button').nth(1).click();
await page.waitForTimeout(900);
const trigger = page.locator('.result-row .icon-button').first();
await trigger.click();
await page.waitForTimeout(300);
const menuOpen1 = await page.locator('.row-menu__pop').count();
const focusInMenu = await page.evaluate(() => Boolean(document.activeElement?.closest('.row-menu__pop')));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const menuOpen2 = await page.locator('.row-menu__pop').count();
const focusBackOnTrigger = await page.evaluate(() => document.activeElement?.classList.contains('icon-button'));
console.log(`menu: open=${menuOpen1 === 1} focusMovedIn=${focusInMenu} escClosed=${menuOpen2 === 0} focusRestored=${focusBackOnTrigger}`);

// Dialog: Playlists > New playlist, Escape closes, focus trap works.
await page.locator('nav button').nth(2).click();
await page.waitForTimeout(500);
await page.locator('.playlist-create-row button').click();
await page.waitForTimeout(300);
const dialogOpen = await page.locator('.dialog').count();
const rootInert = await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'));
// tab several times — focus must stay in dialog
let trapped = true;
for (let i = 0; i < 8; i++) {
  await page.keyboard.press('Tab');
  const inDialog = await page.evaluate(() => Boolean(document.activeElement?.closest('.dialog')));
  if (!inDialog) trapped = false;
}
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const dialogClosed = (await page.locator('.dialog').count()) === 0;
const rootInertAfter = await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'));
console.log(`dialog: open=${dialogOpen === 1} rootInert=${rootInert} focusTrapped=${trapped} escClosed=${dialogClosed} inertRemoved=${!rootInertAfter}`);

await browser.close();
