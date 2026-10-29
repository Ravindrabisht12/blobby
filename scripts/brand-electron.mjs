// Runs after `npm install` on macOS. The Dock names an app after its folder and reads its icon from
// the bundle, so when Blobby runs from source it would say "Electron". This moves this project's copy
// to node_modules/electron/dist/Blobby.app (leaving an Electron.app link so the electron package and
// existing AI app configs still find it), renames it, gives it the Blobby icon and its own bundle ID,
// and re-signs it ad hoc. Only this project's copy is changed. Safe to run again; failures are ignored.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'darwin') process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'node_modules', 'electron', 'dist');
const appDir = path.join(dist, 'Blobby.app');
const link = path.join(dist, 'Electron.app');
const plist = path.join(appDir, 'Contents', 'Info.plist');
const BUNDLE_ID = 'dev.blobby.app';
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'ignore' });
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

try {
  // A fresh install has a real Electron.app: move it to Blobby.app and leave a link behind.
  if (fs.existsSync(link) && !isLink(link)) {
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.renameSync(link, appDir);
  }
  if (!fs.existsSync(plist)) process.exit(0);
  if (!fs.existsSync(link)) fs.symlinkSync('Blobby.app', link);
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) run('plutil', ['-replace', key, '-string', 'Blobby', plist]);

  // Every Electron copy shares the ID com.github.Electron, so the Dock may show the name of another
  // copy on the same Mac. Give ours (and its helper apps) a unique ID.
  run('plutil', ['-replace', 'CFBundleIdentifier', '-string', BUNDLE_ID, plist]);
  const frameworks = path.join(appDir, 'Contents', 'Frameworks');
  for (const helper of fs.readdirSync(frameworks).filter((f) => f.endsWith('.app'))) {
    const hp = path.join(frameworks, helper, 'Contents', 'Info.plist');
    const id = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', hp]).toString().trim();
    run('plutil', ['-replace', 'CFBundleIdentifier', '-string', id.replace(/^com\.github\.Electron/, BUNDLE_ID), hp]);
  }

  // Build an .icns from assets/icon.png and swap it in.
  const png = path.join(root, 'assets', 'icon.png');
  const icns = path.join(appDir, 'Contents', 'Resources', 'electron.icns');
  if (fs.existsSync(png)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blobby-icon-'));
    const set = path.join(tmp, 'blobby.iconset');
    fs.mkdirSync(set);
    for (const size of [16, 32, 128, 256, 512]) {
      run('sips', ['-z', String(size), String(size), png, '--out', path.join(set, `icon_${size}x${size}.png`)]);
      run('sips', ['-z', String(size * 2), String(size * 2), png, '--out', path.join(set, `icon_${size}x${size}@2x.png`)]);
    }
    run('iconutil', ['-c', 'icns', set, '-o', icns]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Editing the bundle breaks its signature; re-sign it locally (ad hoc) so macOS still runs it.
  run('codesign', ['--force', '--deep', '--sign', '-', appDir]);

  // Ask macOS to pick up the new name and icon instead of its cached ones.
  fs.utimesSync(appDir, new Date(), new Date());
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  if (fs.existsSync(lsregister)) run(lsregister, ['-f', appDir]);
  console.log('Blobby: named the local Electron app "Blobby" for the Dock.');
} catch (err) {
  console.log(`Blobby: couldn't rename the local Electron app (${err.message}). The app still works; the Dock may say "Electron".`);
}
