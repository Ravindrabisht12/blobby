// Rendering tasks shared by desktop (Electron windows) and web (headless Chrome via Playwright).
//
// A driver opens a page and returns a handle:
//   driver.open(url, { width, height, scale, isolated, userAgent }) -> {
//     evaluate(jsSource) -> value, resize(w, h), capture({ width, height }) -> { data, mimeType },
//     consoleErrors: string[], close()
//   }
// `scale` shrinks captured images (e.g. 0.7) so they stay inside what AI clients accept.

import { DEVICES } from './preview.js';
import { siteProbe, qaProbe } from './probes.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_IMAGE_SIDE = 7800;

const SETTLE = 'document.fonts.ready.then(() => Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; setTimeout(r, 4000); })))).then(() => new Promise(r => setTimeout(r, 250)))';

async function captureFull(handle, width, height, scale, { full = true, maxHeight = 12000 } = {}) {
  const contentHeight = await handle.evaluate('document.documentElement.scrollHeight');
  const cap = Math.min(maxHeight, Math.floor(MAX_IMAGE_SIDE / scale));
  const h = full ? Math.min(Math.max(contentHeight, height), cap) : height;
  await handle.resize(width, h);
  return { shot: await handle.capture({ width, height: h }), h };
}

export function createRenderTasks(driver, { pageUrl }) {
  async function openPage(project, page, device, scale) {
    const d = DEVICES[device];
    const handle = await driver.open(pageUrl(project, page, d.height), { width: d.width, height: d.height, scale });
    await handle.evaluate(SETTLE);
    return handle;
  }

  async function screenshot({ project, page, device = 'desktop', full = true }) {
    const d = DEVICES[device];
    const scale = Math.min(1, (device === 'desktop' ? 1280 : d.width) / d.width);
    const handle = await openPage(project, page, device, scale);
    try {
      const { shot, h } = await captureFull(handle, d.width, d.height, scale, { full });
      return { ...shot, width: d.width, height: h };
    } finally { handle.close(); }
  }

  async function qa({ project, page, devices = ['desktop', 'tablet', 'mobile'] }) {
    const results = [];
    for (const device of devices) {
      const d = DEVICES[device];
      const scale = device === 'desktop' ? 1000 / d.width : 1;
      const handle = await openPage(project, page, device, scale);
      try {
        const report = await handle.evaluate(`(${qaProbe.toString()})()`);
        for (const msg of handle.consoleErrors) report.issues.push({ severity: 'error', rule: 'js-error', message: msg });
        const { shot } = await captureFull(handle, d.width, d.height, scale, { maxHeight: 9000 });
        results.push({ device, width: d.width, pageHeight: report.pageHeight, issues: report.issues, screenshot: shot });
      } finally { handle.close(); }
    }
    return { project, page, results };
  }

  // Small preview image for the dashboard.
  async function thumbnail({ project, page }) {
    const scale = 480 / 1440;
    const handle = await openPage(project, page, 'desktop', scale);
    try {
      await handle.resize(1440, 1000);
      return await handle.capture({ width: 1440, height: 1000 });
    } finally { handle.close(); }
  }

  // Opens a client's live site in an isolated window and reads its real brand.
  async function analyzeSite({ url }) {
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const desktopUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
    const mobileUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const scrollThrough = '(async () => { const h = document.documentElement.scrollHeight; for (let y = 0; y < Math.min(h, 12000); y += 700) { scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); } scrollTo(0, 0); await new Promise(r => setTimeout(r, 600)); })()';
    const screenshots = [];
    let data;

    const scale = 1000 / 1440;
    const desk = await driver.open(target, { width: 1440, height: 900, scale, isolated: true, userAgent: desktopUA });
    try {
      await wait(1500);
      await desk.evaluate(scrollThrough);
      data = await desk.evaluate(`(${siteProbe.toString()})()`);
      screenshots.push({ label: 'Desktop, first screen', ...(await desk.capture({ width: 1440, height: 900 })) });
      const { shot, h } = await captureFull(desk, 1440, 900, scale, { maxHeight: 6000 });
      screenshots.push({ label: `Desktop, full page (first ${h}px)`, ...shot });
    } finally { desk.close(); }

    const mob = await driver.open(target, { width: 390, height: 844, scale: 1, isolated: true, userAgent: mobileUA });
    try {
      await wait(1200);
      const { shot } = await captureFull(mob, 390, 844, 1, { maxHeight: 3400 });
      screenshots.push({ label: 'Mobile, top of page', ...shot });
    } catch { /* desktop data is enough */ } finally { mob.close(); }

    return { data, screenshots };
  }

  // Crop of one element, for feedback pins created in the web app. rect is in page pixels.
  async function elementShot({ project, page, device = 'desktop', rect }) {
    const d = DEVICES[device];
    const handle = await openPage(project, page, device, 1);
    try {
      const contentHeight = await handle.evaluate('document.documentElement.scrollHeight');
      await handle.resize(d.width, Math.min(Math.max(contentHeight, d.height), 12000));
      const pad = 12;
      const x = Math.max(0, rect.x - pad);
      const y = Math.max(0, rect.y - pad);
      return await handle.capture({ x, y, width: Math.min(d.width - x, rect.w + pad * 2), height: Math.min(1600, rect.h + pad * 2) });
    } finally { handle.close(); }
  }

  return { screenshot, qa, thumbnail, analyzeSite, elementShot };
}
