// `npm start`: runs Blobby from source. On macOS it launches through Blobby.app (set up by
// scripts/brand-electron.mjs) because the Dock names an app after its folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import electronPath from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const branded = path.join(root, 'node_modules', 'electron', 'dist', 'Blobby.app', 'Contents', 'MacOS', 'Electron');
const bin = process.platform === 'darwin' && fs.existsSync(branded) ? branded : electronPath;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(bin, [root, ...process.argv.slice(2)], { stdio: 'inherit', env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
