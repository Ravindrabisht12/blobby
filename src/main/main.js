import { app, BrowserWindow, Menu, protocol, ipcMain, net, dialog, shell, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as store from '../shared/store.js';
import { createBlobbyServer } from '../mcp/tools.js';
import { rewriteVh } from '../shared/preview.js';
import { createRenderTasks } from '../shared/render-tasks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..');
const MCP_SERVER = path.join(SRC, 'mcp', 'server.js');
const BRIDGE_FILE = path.join(store.ROOT, '.bridge.json');

let mainWindow = null;
let currentSelection = null;

protocol.registerSchemesAsPrivileged([
  { scheme: 'blobby', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// ---------- blobby:// protocol ----------
//   blobby://local/app/<path>          app UI files from src/
//   blobby://local/p/<project>/<path>  project files (pages, assets); ?vh=900 enables editor rendering

function insideDir(dir, file) {
  const rel = path.relative(dir, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function registerProtocol() {
  protocol.handle('blobby', async (req) => {
    const url = new URL(req.url);
    const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    let file;
    if (parts[0] === 'app') file = path.join(SRC, ...parts.slice(1));
    else if (parts[0] === 'p') file = path.join(store.ROOT, ...parts.slice(1));
    const base = parts[0] === 'app' ? SRC : store.ROOT;
    if (!file || !insideDir(base, file) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return new Response('Not found', { status: 404 });
    }
    const vh = Number(url.searchParams.get('vh'));
    if (file.endsWith('.html') && vh) {
      const html = rewriteVh(fs.readFileSync(file, 'utf8'), vh);
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

// ---------- window ----------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1000,
    minHeight: 640,
    title: 'Blobby',
    backgroundColor: '#191919',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL('blobby://local/app/renderer/index.html');
  mainWindow.on('closed', () => { mainWindow = null; });
  // Dev aid: BLOBBY_CAPTURE=/path.png saves a screenshot of the window once it has rendered.
  if (process.env.BLOBBY_CAPTURE) {
    setTimeout(async () => {
      const img = await mainWindow.webContents.capturePage();
      fs.writeFileSync(process.env.BLOBBY_CAPTURE, img.toPNG());
      if (process.env.BLOBBY_CAPTURE_QUIT) app.quit();
    }, Number(process.env.BLOBBY_CAPTURE_DELAY || 4000));
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------- live updates from disk (the MCP server writes files directly) ----------

function watchStore() {
  store.ensureRoot();
  let pending = new Set();
  let timer = null;
  fs.watch(store.ROOT, { recursive: true }, (_event, rel) => {
    if (!rel || rel.includes('.history') || rel.startsWith('.bridge') || rel.startsWith('_exports')) return;
    const norm = rel.split(path.sep).join('/');
    pending.add(norm);
    const m = norm.match(/^([^/]+)\/pages\/([^/]+)\.html$/);
    if (m && fs.existsSync(path.join(store.ROOT, norm))) scheduleThumb(m[1], m[2]);
    clearTimeout(timer);
    timer = setTimeout(() => {
      send('store-changed', { paths: [...pending] });
      pending = new Set();
    }, 120);
  });
}

// ---------- rendering: screenshots, QA, client sites, thumbnails ----------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Electron implementation of the render driver used by src/shared/render-tasks.js.
const electronDriver = {
  async open(url, { width, height, scale = 1, isolated = false, userAgent } = {}) {
    const webPreferences = isolated
      ? { partition: 'blobby-sites', sandbox: true, contextIsolation: true, backgroundThrottling: false }
      : { backgroundThrottling: false };
    const win = new BrowserWindow({ show: false, width, height, useContentSize: true, webPreferences });
    const consoleErrors = [];
    win.webContents.on('console-message', (e, level, message) => {
      const lvl = e.level ?? level;
      if (lvl === 'error' || lvl === 3) consoleErrors.push(String(e.message ?? message).slice(0, 300));
    });
    if (isolated) {
      win.webContents.setAudioMuted(true);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await Promise.race([win.loadURL(url, userAgent ? { userAgent } : {}).catch(() => {}), wait(30000)]);
    } else {
      await win.loadURL(url);
    }
    return {
      consoleErrors,
      evaluate: (src) => win.webContents.executeJavaScript(src),
      async resize(w, h) { win.setContentSize(w, h); await wait(300); },
      async capture({ x = 0, y = 0, width: w, height: h }) {
        let img = await win.webContents.capturePage({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
        if (scale < 1) img = img.resize({ width: Math.round(w * scale), quality: 'good' });
        return { data: img.toJPEG(80).toString('base64'), mimeType: 'image/jpeg' };
      },
      close: () => { if (!win.isDestroyed()) win.destroy(); },
    };
  },
};

const tasks = createRenderTasks(electronDriver, {
  pageUrl: (project, page, vh) => `blobby://local/p/${project}/pages/${page}.html?vh=${vh}&t=${Date.now()}`,
});

function resolvePage(project, page) {
  const p = store.requireProject(project);
  return { project: p.slug, page: store.requirePage(p.slug, page).slug };
}

// Thumbnails for the dashboard: regenerated a few seconds after a page stops changing.
const thumbTimers = new Map();
function scheduleThumb(project, page, delay = 2500) {
  const key = `${project}/${page}`;
  clearTimeout(thumbTimers.get(key));
  thumbTimers.set(key, setTimeout(async () => {
    thumbTimers.delete(key);
    try {
      const shot = await tasks.thumbnail({ project, page });
      store.saveThumb(project, page, shot.data);
    } catch { /* page deleted or invalid; skip */ }
  }, delay));
}

function ensureThumbs() {
  for (const p of store.listProjects()) {
    for (const pg of p.pages) {
      const f = store.thumbFile(p.slug, pg.slug);
      if (!fs.existsSync(f) || fs.statSync(f).mtimeMs < fs.statSync(pg.file).mtimeMs) scheduleThumb(p.slug, pg.slug, 500);
    }
  }
}

// ---------- local bridge for the MCP server ----------

const bridgeToken = crypto.randomBytes(24).toString('hex');

const bridgeMethods = {
  ping: () => ({ ok: true, app: 'blobby', version: app.getVersion() }),
  activity: (params) => { send('ai-activity', params); return { ok: true }; },
  open: (params) => { send('open-page', params); mainWindow?.show(); return { ok: true }; },
  selection: () => currentSelection,
  screenshot: ({ project, page, device, full }) => tasks.screenshot({ ...resolvePage(project, page), device, full }),
  qa: ({ project, page, devices }) => tasks.qa({ ...resolvePage(project, page), devices }),
  analyzeSite: ({ url }) => tasks.analyzeSite({ url }),
};

function startBridge() {
  const server = http.createServer((req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.headers['x-blobby-token'] !== bridgeToken) return reply(403, { error: 'forbidden' });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const { method, params } = JSON.parse(body || '{}');
        const fn = bridgeMethods[method];
        if (!fn) return reply(404, { error: `unknown method ${method}` });
        reply(200, { result: await fn(params || {}) });
      } catch (err) {
        reply(500, { error: err.message });
      }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const launch = app.isPackaged ? { command: process.execPath, args: [] } : { command: process.execPath, args: [app.getAppPath()] };
    store.ensureRoot();
    fs.writeFileSync(BRIDGE_FILE, JSON.stringify({ port, token: bridgeToken, pid: process.pid, launch }, null, 2), { mode: 0o600 });
  });
  // On quit, keep only the launch command so the MCP server can start the app next time.
  app.on('will-quit', () => {
    try {
      const cur = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
      if (cur.pid === process.pid) fs.writeFileSync(BRIDGE_FILE, JSON.stringify({ launch: cur.launch }, null, 2), { mode: 0o600 });
    } catch { /* already gone */ }
  });
}

// ---------- MCP over HTTP (Cursor, VS Code, Windsurf, ChatGPT via a tunnel, …) ----------
// Stateless Streamable HTTP. The random key in the path is the credential.

const CONFIG_FILE = path.join(store.ROOT, '.config.json');
const mcpHttp = { url: null, error: null };

function appConfig() {
  const cfg = readJsonSafe(CONFIG_FILE) || {};
  if (!cfg.mcpKey || !cfg.mcpPort) {
    cfg.mcpKey = cfg.mcpKey || crypto.randomBytes(16).toString('hex');
    cfg.mcpPort = cfg.mcpPort || Number(process.env.BLOBBY_MCP_PORT) || 7788;
    store.ensureRoot();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }
  return cfg;
}

function startHttpMcp() {
  const cfg = appConfig();
  const host = { running: async () => true, ensure: async () => true, call: async (method, params) => bridgeMethods[method](params || {}) };
  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== `/mcp/${cfg.mcpKey}`) { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
    const mcp = createBlobbyServer(host);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end(err.message);
    }
  });
  server.on('error', (err) => { mcpHttp.error = `Port ${cfg.mcpPort}: ${err.message}`; });
  server.listen(cfg.mcpPort, '127.0.0.1', () => { mcpHttp.url = `http://127.0.0.1:${cfg.mcpPort}/mcp/${cfg.mcpKey}`; });
}

// ---------- connecting AI clients ----------

function mcpLaunch() {
  return { command: process.execPath, args: [MCP_SERVER], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

const DESKTOP_CONFIG = path.join(
  process.platform === 'win32' ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'Claude', 'claude_desktop_config.json',
);

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function claudeStatus() {
  const desktop = readJsonSafe(DESKTOP_CONFIG);
  const code = readJsonSafe(path.join(os.homedir(), '.claude.json'));
  const launch = mcpLaunch();
  return {
    desktop: Boolean(desktop?.mcpServers?.blobby),
    code: Boolean(code?.mcpServers?.blobby),
    codeCommand: `claude mcp add blobby -s user -e ELECTRON_RUN_AS_NODE=1 -- "${launch.command}" "${launch.args[0]}"`,
    json: JSON.stringify({ mcpServers: { blobby: launch } }, null, 2),
    httpUrl: mcpHttp.url,
    httpError: mcpHttp.error,
    httpJson: mcpHttp.url ? JSON.stringify({ mcpServers: { blobby: { url: mcpHttp.url } } }, null, 2) : '',
    vscodeJson: mcpHttp.url ? JSON.stringify({ servers: { blobby: { type: 'http', url: mcpHttp.url } } }, null, 2) : '',
  };
}

function connectDesktop() {
  const cfg = readJsonSafe(DESKTOP_CONFIG) || {};
  if (fs.existsSync(DESKTOP_CONFIG)) fs.copyFileSync(DESKTOP_CONFIG, DESKTOP_CONFIG + '.blobby-backup');
  cfg.mcpServers = { ...(cfg.mcpServers || {}), blobby: mcpLaunch() };
  fs.mkdirSync(path.dirname(DESKTOP_CONFIG), { recursive: true });
  fs.writeFileSync(DESKTOP_CONFIG, JSON.stringify(cfg, null, 2));
  return { ok: true, note: 'Restart Claude Desktop to load Blobby.' };
}

function findClaudeCli() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  return candidates.find((c) => fs.existsSync(c)) || 'claude';
}

function connectCode() {
  const launch = mcpLaunch();
  const cli = findClaudeCli();
  const run = (args) => new Promise((resolve) => execFile(cli, args, { timeout: 20000 }, (err, stdout, stderr) => resolve({ err, out: (stdout || '') + (stderr || '') })));
  return run(['mcp', 'remove', 'blobby', '-s', 'user'])
    .then(() => run(['mcp', 'add', 'blobby', '-s', 'user', '-e', 'ELECTRON_RUN_AS_NODE=1', '--', launch.command, launch.args[0]]))
    .then(({ err, out }) => (err ? { ok: false, error: out || err.message } : { ok: true, note: 'Added. Start a new Claude Code session to use Blobby.' }));
}

// ---------- IPC from the UI ----------

const STORE_API = new Set([
  'listProjects', 'createProject', 'readProjectMeta', 'setTokens', 'listPages', 'createPage', 'writeHtml', 'setCss',
  'updateStyles', 'setText', 'setAttributes', 'deleteNodes', 'undo', 'getPageHtml', 'getTree',
  'listFeedback', 'addFeedback', 'updateFeedback', 'deleteFeedback', 'addReply', 'moveNodes',
  'renameProject', 'deleteProject', 'duplicateProject', 'renamePage', 'duplicatePage', 'deletePage',
  'getBrief', 'setBrief',
]);

function registerIpc() {
  ipcMain.handle('store', async (_e, method, args) => {
    if (!STORE_API.has(method)) return { error: `not allowed: ${method}` };
    try { return { result: await store[method](...(args || [])) }; } catch (err) { return { error: err.message }; }
  });
  ipcMain.handle('capture-rect', async (_e, rect) => {
    if (!mainWindow) return null;
    const r = { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
    const img = await mainWindow.webContents.capturePage(r);
    return img.isEmpty() ? null : img.toDataURL();
  });
  ipcMain.handle('export', async (_e, project, page) => {
    const res = await dialog.showOpenDialog(mainWindow, { title: 'Export HTML + CSS to…', properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths[0]) return null;
    const dest = path.join(res.filePaths[0], `${project}-${page}`);
    const out = store.exportPage(project, page, { dest });
    shell.showItemInFolder(path.join(out.dir, 'index.html'));
    return out;
  });
  ipcMain.handle('add-asset', async (_e, project) => {
    const res = await dialog.showOpenDialog(mainWindow, { title: 'Add image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'avif'] }] });
    if (res.canceled || !res.filePaths[0]) return null;
    return store.addAsset(project, { sourcePath: res.filePaths[0] });
  });
  ipcMain.handle('reveal', (_e, project) => shell.openPath(store.projectDir(project)));
  ipcMain.handle('open-external', (_e, url) => (/^(https?|cursor|vscode):/.test(url) ? shell.openExternal(url) : null));
  ipcMain.handle('claude-status', () => claudeStatus());
  ipcMain.handle('connect-desktop', () => connectDesktop());
  ipcMain.handle('connect-code', () => connectCode());
  ipcMain.handle('root', () => store.ROOT);
  ipcMain.handle('app-info', () => ({ version: app.getVersion(), root: store.ROOT, mcpUrl: mcpHttp.url }));
  ipcMain.handle('reveal-root', () => shell.openPath(store.ensureRoot()));
  ipcMain.on('selection-changed', (_e, sel) => { currentSelection = sel; });
}

// ---------- native menu bar ----------
// Items send commands to the UI (runCommand in app.js), which also handles focused text fields.

function buildMenu() {
  const cmd = (label, command, accelerator) => ({ label, accelerator, click: () => send('menu', command) });
  const template = [
    {
      label: app.name,
      submenu: [
        cmd('About Blobby', 'help'),
        { type: 'separator' },
        cmd('Settings…', 'settings', 'CmdOrCtrl+,'),
        cmd('Connect AI…', 'connect'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        cmd('New Project…', 'newProject', 'CmdOrCtrl+Shift+N'),
        cmd('New Page…', 'newPage', 'CmdOrCtrl+N'),
        { type: 'separator' },
        cmd('Export HTML + CSS…', 'export', 'CmdOrCtrl+E'),
        { type: 'separator' },
        cmd('Home', 'home', 'CmdOrCtrl+Shift+H'),
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        cmd('Undo', 'undo', 'CmdOrCtrl+Z'),
        cmd('Redo', 'redo', 'CmdOrCtrl+Shift+Z'),
        { type: 'separator' },
        cmd('Cut', 'cut', 'CmdOrCtrl+X'),
        cmd('Copy', 'copy', 'CmdOrCtrl+C'),
        cmd('Paste', 'paste', 'CmdOrCtrl+V'),
        cmd('Duplicate', 'duplicate', 'CmdOrCtrl+D'),
        cmd('Select All', 'selectAll', 'CmdOrCtrl+A'),
        { type: 'separator' },
        cmd('Comment on Selection', 'comment'),
      ],
    },
    {
      label: 'View',
      submenu: [
        cmd('Toggle Left Sidebar', 'toggleLeft', 'Alt+CmdOrCtrl+1'),
        cmd('Toggle Right Panel', 'toggleRight', 'Alt+CmdOrCtrl+2'),
        cmd('Hide or Show Both Panels', 'togglePanels', 'CmdOrCtrl+\\'),
        { type: 'separator' },
        cmd('Zoom In', 'zoomIn', 'CmdOrCtrl+='),
        cmd('Zoom Out', 'zoomOut', 'CmdOrCtrl+-'),
        cmd('Zoom to Fit', 'zoomFit', 'CmdOrCtrl+0'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'reload' }, { role: 'toggleDevTools' }]),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        cmd('Getting Started', 'help'),
        cmd('Keyboard Shortcuts', 'shortcuts', 'CmdOrCtrl+/'),
        { type: 'separator' },
        { label: 'Open Blobby Folder', click: () => shell.openPath(store.ensureRoot()) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  app.setName('Blobby');
  buildMenu();
  const icon = nativeImage.createFromPath(path.join(SRC, '..', 'assets', 'icon.png'));
  if (process.platform === 'darwin' && app.dock && !icon.isEmpty()) app.dock.setIcon(icon);
  registerProtocol();
  registerIpc();
  watchStore();
  startBridge();
  startHttpMcp();
  createWindow();
  setTimeout(ensureThumbs, 1500);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
