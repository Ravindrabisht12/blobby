// Renders an SVG to a transparent PNG with Electron: electron scripts/render-icon.mjs <in.svg> <out.png> [size]
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
const [input = 'assets/icon.svg', output = 'assets/icon.png', size = '1024'] = process.argv.slice(2).filter((a) => !a.startsWith('-') && !a.endsWith('render-icon.mjs') && a !== '.');
app.whenReady().then(async () => {
  const s = Number(size);
  const win = new BrowserWindow({ show: false, width: s, height: s, transparent: true, frame: false, useContentSize: true });
  const svg = fs.readFileSync(path.resolve(input), 'utf8').replace('<svg', `<svg width="${s}" height="${s}"`);
  await win.loadURL('data:text/html,' + encodeURIComponent(`<html style="background:transparent"><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
  app.quit();
});
