// Drives the real desktop app (Electron) with Playwright against a temporary BLOBBY_HOME:
// dashboard, tabs, select, design panel, comments, reorder, resize, undo, tool rail, panels,
// settings, Connect AI and shortcuts. Saves screenshots to $OUT.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blobby-ui-'));
process.env.BLOBBY_HOME = home;
const store = await import('../src/shared/store.js');
const out = process.env.OUT || home;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };
const html = () => store.getPageHtml('acme-coffee', 'landing').html;

// Seed a realistic project before the app starts.
store.createProject({ name: 'Acme Coffee', site: 'acme.coffee' });
store.setTokens('acme-coffee', { vars: { 'color-primary': '#3b2a1f', 'color-accent': '#f2b544', 'color-bg': '#fbf7f2', 'font-display': '"Fraunces", serif' }, fonts: ['Inter:wght@400;500;600;700', 'Fraunces:opsz,wght@9..144,600'] });
store.createPage('acme-coffee', { name: 'Landing', css: `.wrap{max-width:1200px;margin:0 auto;padding:0 24px}nav{display:flex;justify-content:space-between;align-items:center;padding:20px 0}.logo{font-family:var(--font-display);font-size:24px;font-weight:600}nav ul{display:flex;gap:28px;list-style:none;margin:0;padding:0}.btn{display:inline-block;background:var(--color-primary);color:#fff;padding:14px 22px;border-radius:999px;text-decoration:none;font-weight:600}.hero{display:grid;grid-template-columns:1.1fr .9fr;gap:48px;align-items:center;padding:64px 0}.hero h1{font-family:var(--font-display);font-size:68px;line-height:1.02;margin:0 0 20px}.hero p{font-size:19px;color:var(--color-muted);margin:0 0 28px}.art{aspect-ratio:4/5;border-radius:28px;background:linear-gradient(160deg,var(--color-accent),#e07a3f)}.feats{display:flex;gap:20px;padding:40px 0 80px}.card{flex:1;background:#fff;border:1px solid var(--color-line);border-radius:20px;padding:28px}@media (max-width:768px){.hero{grid-template-columns:1fr}.feats{flex-direction:column}nav ul{display:none}}` });
store.writeHtml('acme-coffee', 'landing', { html: '<div class="wrap"><nav><span class="logo">Acme Coffee</span><ul><li><a href="#">Shop</a></li><li><a href="#">Subscribe</a></li></ul><a class="btn" href="#">Order now</a></nav><section class="hero"><div><h1>Fresh roasted, at your door every week.</h1><p>Small-batch beans roasted to order.</p><a class="btn" href="#">Start my subscription</a></div><div class="art"></div></section><section class="feats"><div class="card"><h3>Roasted to order</h3></div><div class="card"><h3>Free shipping</h3></div><div class="card"><h3>Skip anytime</h3></div></section></div>' });
store.createPage('acme-coffee', { name: 'Pricing', html: '<section style="padding:80px"><h1>Pricing</h1></section>' });

const app = await electron.launch({
  executablePath: electronPath,
  args: ['.'],
  env: { ...process.env, BLOBBY_HOME: home, BLOBBY_MCP_PORT: '7799', ELECTRON_RUN_AS_NODE: '' },
});

try {
  const a = await app.firstWindow();
  a.on('pageerror', (e) => { console.log('PAGE ERROR:', e.message); failures++; });
  await a.waitForSelector('.card[data-open-page]');
  await wait(6000); // thumbnails
  await a.click('[data-nav=projects]');
  await a.click('[data-nav=recents]');
  await wait(600);
  await a.screenshot({ path: `${out}/ui-1-dashboard.png` });
  check(await a.locator('.card[data-open-page]').count() === 2, 'dashboard lists recent pages');
  await a.click('[data-view=list]');
  check(await a.locator('.rowi[data-open-page]').count() === 2, 'list view shows rows');
  await a.click('[data-view=grid]');

  // Open the editor.
  await a.click('.card[data-open-page="landing"]');
  await a.waitForSelector('.layer');
  await wait(1200);
  check(await a.locator('.layer').count() >= 1, 'layers tree renders');
  check((await a.locator('#openTabs .tab.on').textContent()).includes('Landing'), 'opening a page adds a tab');

  const frame = a.frameLocator('.artboard >> nth=0 >> iframe');
  const h1Box = await frame.locator('h1').boundingBox();
  await a.mouse.click(h1Box.x + 20, h1Box.y + 10);
  await wait(400);
  check((await a.locator('#panelInspect .el-tag').textContent()) === 'h1', 'clicking the canvas selects the element');
  check(await a.locator('.layer.sel').count() === 1, 'selection is highlighted in layers');
  await a.screenshot({ path: `${out}/ui-2-selected.png` });

  // Design panel: step the font size and commit.
  const fs1 = a.locator('input[data-prop="font-size"]');
  await fs1.click();
  await fs1.press('Shift+ArrowUp');
  await wait(900);
  check(/font-size: 78px/.test(html()), 'design panel stepping writes the style (68→78px)');

  // Comment with C; the app attaches a screenshot of the element.
  await a.mouse.click(h1Box.x + 20, h1Box.y + 10);
  await a.keyboard.press('c');
  await a.fill('#fbText', 'Mention free shipping in the headline');
  await a.keyboard.press('Meta+Enter');
  await wait(1200);
  const fb = store.listFeedback('acme-coffee', { status: 'open' });
  check(fb.length === 1 && !!fb[0].screenshotFile, 'comment saved with an element screenshot');
  check(await a.locator('.pin').count() >= 1, 'comment pin shows on the canvas');
  await a.locator('[data-reply]').first().fill('Keep it under 8 words');
  await a.locator('[data-reply]').first().press('Enter');
  await wait(800);
  check(store.listFeedback('acme-coffee', { status: 'open' })[0].replies.length === 1, 'reply added to thread');
  await a.screenshot({ path: `${out}/ui-3-comments.png` });

  // Reorder with ⌥↓.
  await a.click('.tabs [data-tab="inspect"]');
  const cardBox = await frame.locator('.card >> nth=0').boundingBox();
  await a.mouse.click(cardBox.x + cardBox.width - 12, cardBox.y + cardBox.height - 12);
  await wait(300);
  await a.keyboard.press('Alt+ArrowDown');
  await wait(1200);
  const titles = () => html().match(/<h3[^>]*>([^<]+)/g).map((s) => s.replace(/<[^>]+>/, ''));
  let order = titles();
  check(order[0] === 'Free shipping' && order[1] === 'Roasted to order', `⌥↓ reorders siblings (${order.join(', ')})`);

  // Drag on the canvas: "Skip anytime" before the first card.
  const c3 = await frame.locator('.card >> nth=2').boundingBox();
  const c1 = await frame.locator('.card >> nth=0').boundingBox();
  await a.mouse.click(c3.x + c3.width - 10, c3.y + c3.height - 10);
  await wait(200);
  await a.mouse.move(c3.x + c3.width - 10, c3.y + c3.height - 10);
  await a.mouse.down();
  await a.mouse.move(c1.x + 10, c1.y + c1.height / 2, { steps: 12 });
  await a.mouse.up();
  await wait(1200);
  order = titles();
  check(order[0] === 'Skip anytime', `drag on canvas reorders (${order.join(', ')})`);

  // Resize with the east handle, then undo.
  await wait(600);
  const art = await frame.locator('.art').boundingBox();
  await a.mouse.click(art.x + art.width / 2, art.y + art.height / 2);
  await wait(300);
  const handle = await a.locator('.handle[data-h="e"]').boundingBox();
  await a.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await a.mouse.down();
  await a.mouse.move(handle.x - 60, handle.y + handle.height / 2, { steps: 6 });
  await a.mouse.up();
  await wait(1000);
  check(/class="art" style="width: \d+px"|style="width: \d+px"[^>]*class="art"/.test(html()), 'resize handle sets width');
  await a.keyboard.press('Escape');
  await a.keyboard.press('Meta+z');
  await wait(1000);
  check(!/width: \d+px/.test(html().match(/<div[^>]*class="art"[^>]*>/)[0]), '⌘Z undoes the resize');

  // Tool rail.
  const fc = await frame.locator('.feats .card >> nth=0').boundingBox();
  await a.mouse.click(fc.x + fc.width - 8, fc.y + fc.height - 8);
  await wait(200);
  await a.click('#rail [data-insert=text]');
  await wait(1200);
  check(/Write something/.test(html()), 'rail inserts a text element');
  await a.click('#rail [data-tool=hand]');
  check(await a.locator('#app.mode-hand').count() === 1, 'hand tool is active');
  await a.keyboard.press('v');
  await a.keyboard.press('Meta+z');
  await wait(800);

  // Panels collapse to floating bars and come back.
  await a.keyboard.press('Escape');
  await a.click('#toggleLeft');
  await a.click('#toggleRight');
  await wait(300);
  check(!(await a.locator('#layers').isVisible()) && await a.locator('#zoomBtn').isVisible(), 'panels collapse to floating bars');
  await a.screenshot({ path: `${out}/ui-4-focus.png` });
  await a.keyboard.press('Alt+Meta+Digit1');
  await a.keyboard.press('Alt+Meta+Digit2');
  await wait(200);
  check(await a.locator('#layers').isVisible() && await a.locator('.panel .tabs').isVisible(), '⌥⌘1 / ⌥⌘2 bring the panels back');

  // Account menu → settings page.
  await a.click('#accountBtn');
  await wait(200);
  check((await a.locator('#menu .who b').textContent()) === 'Blobby', 'account menu opens');
  await a.locator('#menu button', { hasText: 'Settings' }).click();
  await a.waitForSelector('.settings-page');
  check((await a.locator('.settings-page').textContent()).includes(home), 'settings shows the projects folder');
  await a.click('.utabs [data-stab=about]');
  check((await a.locator('.settings-page').textContent()).includes('MIT License'), 'about shows the license');
  await a.screenshot({ path: `${out}/ui-5-settings.png` });

  // Connect AI.
  await a.click('#connectBtn');
  await a.waitForSelector('.cx-list');
  check(await a.locator('.cx-list button svg').count() >= 9, 'Connect lists agents with logos');
  await a.click('.cx-list [data-agent=cursor]');
  check(await a.locator('.opt button', { hasText: 'Add to Cursor' }).count() === 1 && await a.locator('.prompt-chip').count() === 3, 'Cursor setup has a one-click button and first prompts');
  await a.screenshot({ path: `${out}/ui-6-connect.png` });
  await a.keyboard.press('Escape');
  await a.keyboard.press('Meta+/');
  await wait(200);
  check(await a.locator('.keys kbd').count() > 20, '⌘/ opens keyboard shortcuts');
  await a.keyboard.press('Escape');

  // Project view.
  await a.click('#projectList [data-project="acme-coffee"]');
  await wait(500);
  check(await a.locator('.card[data-open-page]').count() === 2 && await a.locator('.dash-head [data-new-page]').count() === 1, 'project view lists pages with New page');
  await a.screenshot({ path: `${out}/ui-7-project.png` });
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await app.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
