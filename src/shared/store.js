// Blobby project store. Shared by the Electron app and the MCP server.
//
// Everything lives in plain folders so projects are portable and diffable:
//   ~/Blobby/<project>/project.json      name, site, brand tokens
//   ~/Blobby/<project>/pages/<page>.html full HTML documents (the source of truth)
//   ~/Blobby/<project>/assets/           images, fonts, logos
//   ~/Blobby/<project>/feedback.json     comments pinned to elements
//   ~/Blobby/<project>/.history/<page>/  snapshots before every change (undo)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { parseHTML } from 'linkedom';

// Everything lives under one folder (BLOBBY_HOME, default ~/Blobby). withRoot(<dir>, fn) runs
// fn against another folder with the same layout, e.g. for tests or a future hosted version.
const ROOT = process.env.BLOBBY_HOME || path.join(os.homedir(), 'Blobby');
const rootContext = new AsyncLocalStorage();
const root = () => rootContext.getStore() || ROOT;
function withRoot(dir, fn) { return rootContext.run(dir, fn); }
const ID_ATTR = 'data-b-id';
const HISTORY_LIMIT = 40;

function ensureRoot() {
  fs.mkdirSync(root(), { recursive: true });
  return root();
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

function newId(prefix = 'b') {
  return prefix + crypto.randomBytes(4).toString('hex').slice(0, 6);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---------- projects ----------

function projectDir(slug) { return path.join(root(), slug); }

function listProjects() {
  ensureRoot();
  return fs.readdirSync(root(), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map((d) => readProjectMeta(d.name))
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function readProjectMeta(slug) {
  const meta = readJson(path.join(projectDir(slug), 'project.json'), null);
  if (!meta) return null;
  return { ...meta, slug, pages: listPages(slug) };
}

function touchProject(slug) {
  const file = path.join(projectDir(slug), 'project.json');
  const meta = readJson(file, null);
  if (!meta) return;
  meta.updatedAt = new Date().toISOString();
  writeJson(file, meta);
}

function defaultTokens() {
  return {
    vars: {
      '--color-bg': '#ffffff',
      '--color-fg': '#16161a',
      '--color-muted': '#6b6b76',
      '--color-primary': '#16161a',
      '--color-on-primary': '#ffffff',
      '--color-accent': '#ddff46',
      '--color-line': '#e6e6ea',
      '--font-sans': '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
      '--radius': '10px',
      '--container': '1200px',
    },
    fonts: ['Inter:wght@400;500;600;700'],
  };
}

function createProject({ name, site, description, tokens } = {}) {
  ensureRoot();
  if (!name) throw new Error('Project name is required');
  let slug = slugify(name);
  let n = 2;
  while (fs.existsSync(projectDir(slug))) slug = `${slugify(name)}-${n++}`;
  const now = new Date().toISOString();
  const meta = {
    name,
    site: site || '',
    description: description || '',
    tokens: mergeTokens(defaultTokens(), tokens),
    createdAt: now,
    updatedAt: now,
  };
  fs.mkdirSync(path.join(projectDir(slug), 'pages'), { recursive: true });
  fs.mkdirSync(path.join(projectDir(slug), 'assets'), { recursive: true });
  writeJson(path.join(projectDir(slug), 'project.json'), meta);
  writeJson(path.join(projectDir(slug), 'feedback.json'), []);
  return readProjectMeta(slug);
}

// Accepts a slug, an exact name, or a loose match ("acme" -> "acme-corp").
function findProject(query) {
  if (!query) return null;
  const all = listProjects();
  const q = String(query).toLowerCase();
  const s = slugify(query);
  return all.find((p) => p.slug === q || p.slug === s)
    || all.find((p) => p.name.toLowerCase() === q)
    || all.find((p) => p.slug.includes(s) || p.name.toLowerCase().includes(q))
    || null;
}

function requireProject(query) {
  const p = findProject(query);
  if (!p) {
    const names = listProjects().map((x) => x.slug).join(', ') || '(none yet)';
    throw new Error(`No project matches "${query}". Existing projects: ${names}`);
  }
  return p;
}

function mergeTokens(base, patch) {
  if (!patch) return base;
  return {
    vars: { ...(base.vars || {}), ...(patch.vars || {}) },
    fonts: patch.fonts ? patch.fonts : (base.fonts || []),
  };
}

function setTokens(projectQuery, patch, { replace = false } = {}) {
  const p = requireProject(projectQuery);
  const file = path.join(projectDir(p.slug), 'project.json');
  const meta = readJson(file, {});
  const vars = {};
  for (const [k, v] of Object.entries((patch && patch.vars) || {})) {
    vars[k.startsWith('--') ? k : `--${k}`] = v;
  }
  const normalized = { vars, fonts: patch && patch.fonts };
  meta.tokens = replace ? mergeTokens({ vars: {}, fonts: [] }, normalized) : mergeTokens(meta.tokens || defaultTokens(), normalized);
  meta.updatedAt = new Date().toISOString();
  writeJson(file, meta);
  // Re-render the token block in every page so the canvas updates immediately.
  for (const page of listPages(p.slug)) {
    mutatePage(p.slug, page.slug, (doc) => applyHead(doc, meta, page.title), { snapshot: false });
  }
  return meta.tokens;
}

// ---------- pages ----------

function pagesDir(slug) { return path.join(projectDir(slug), 'pages'); }
function pageFile(slug, page) { return path.join(pagesDir(slug), `${page}.html`); }

function listPages(slug) {
  const dir = pagesDir(slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .map((f) => {
      const file = path.join(dir, f);
      const html = fs.readFileSync(file, 'utf8');
      const m = html.match(/<title>([^<]*)<\/title>/i);
      return { slug: f.replace(/\.html$/, ''), title: m ? m[1] : f, file, updatedAt: fs.statSync(file).mtime.toISOString() };
    })
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

function findPage(projectSlug, query) {
  const pages = listPages(projectSlug);
  if (!query) return pages[pages.length - 1] || null;
  const s = slugify(query);
  return pages.find((p) => p.slug === query || p.slug === s)
    || pages.find((p) => p.title.toLowerCase() === String(query).toLowerCase())
    || pages.find((p) => p.slug.includes(s))
    || null;
}

function requirePage(projectSlug, query) {
  const page = findPage(projectSlug, query);
  if (!page) {
    const names = listPages(projectSlug).map((x) => x.slug).join(', ') || '(none yet)';
    throw new Error(`No page matches "${query}" in ${projectSlug}. Pages: ${names}`);
  }
  return page;
}

function fontsHref(fonts) {
  if (!fonts || !fonts.length) return '';
  const fam = fonts.map((f) => 'family=' + f.replace(/ /g, '+')).join('&');
  return `https://fonts.googleapis.com/css2?${fam}&display=swap`;
}

function tokensCss(tokens) {
  const vars = Object.entries((tokens && tokens.vars) || {}).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `:root {\n${vars}\n}`;
}

const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
html,body{margin:0}
body{background:var(--color-bg,#fff);color:var(--color-fg,#111);font-family:var(--font-sans,system-ui,sans-serif);line-height:1.5;-webkit-font-smoothing:antialiased}
img,svg,video{max-width:100%;display:block}
a{color:inherit}`;

// Keeps the managed <head> pieces (base reset, fonts, tokens) in sync with project.json.
function applyHead(doc, meta, title) {
  const head = doc.head;
  const ensure = (selector, create) => {
    let el = head.querySelector(selector);
    if (!el) { el = create(); head.appendChild(el); }
    return el;
  };
  ensure('meta[charset]', () => { const m = doc.createElement('meta'); m.setAttribute('charset', 'utf-8'); return m; });
  ensure('meta[name="viewport"]', () => {
    const m = doc.createElement('meta');
    m.setAttribute('name', 'viewport');
    m.setAttribute('content', 'width=device-width, initial-scale=1');
    return m;
  });
  const t = ensure('title', () => doc.createElement('title'));
  if (title) t.textContent = title;

  const href = fontsHref(meta.tokens && meta.tokens.fonts);
  let link = head.querySelector('link#blobby-fonts');
  if (href) {
    if (!link) { link = doc.createElement('link'); link.id = 'blobby-fonts'; link.setAttribute('rel', 'stylesheet'); head.appendChild(link); }
    link.setAttribute('href', href);
  } else if (link) link.remove();

  ensure('style#blobby-base', () => { const s = doc.createElement('style'); s.id = 'blobby-base'; return s; }).textContent = BASE_CSS;
  ensure('style#blobby-tokens', () => { const s = doc.createElement('style'); s.id = 'blobby-tokens'; return s; }).textContent = tokensCss(meta.tokens);
  // Page CSS always comes last so it can override tokens and base.
  const css = ensure('style#blobby-css', () => { const s = doc.createElement('style'); s.id = 'blobby-css'; s.textContent = ''; return s; });
  head.appendChild(css);
}

function assignIds(root) {
  const els = root.querySelectorAll ? root.querySelectorAll('*') : [];
  // Pasted or duplicated HTML can carry ids that already exist; first one keeps it.
  const seen = new Set();
  for (const el of els) {
    const id = el.getAttribute(ID_ATTR);
    if (!id || seen.has(id)) el.setAttribute(ID_ATTR, newId());
    seen.add(el.getAttribute(ID_ATTR));
  }
  if (root.getAttribute && !root.getAttribute(ID_ATTR) && root.tagName && root.tagName !== 'BODY') root.setAttribute(ID_ATTR, newId());
}

function loadDoc(projectSlug, pageSlug) {
  const html = fs.readFileSync(pageFile(projectSlug, pageSlug), 'utf8');
  return parseHTML(html).document;
}

function serialize(doc) {
  return '<!doctype html>\n' + doc.documentElement.outerHTML + '\n';
}

function snapshot(projectSlug, pageSlug) {
  const file = pageFile(projectSlug, pageSlug);
  if (!fs.existsSync(file)) return;
  const dir = path.join(projectDir(projectSlug), '.history', pageSlug);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, path.join(dir, `${Date.now()}.html`));
  const snaps = fs.readdirSync(dir).sort();
  for (const old of snaps.slice(0, Math.max(0, snaps.length - HISTORY_LIMIT))) fs.unlinkSync(path.join(dir, old));
}

function mutatePage(projectSlug, pageSlug, fn, { snapshot: snap = true } = {}) {
  if (snap) snapshot(projectSlug, pageSlug);
  const doc = loadDoc(projectSlug, pageSlug);
  const result = fn(doc);
  assignIds(doc.body);
  fs.writeFileSync(pageFile(projectSlug, pageSlug), serialize(doc));
  touchProject(projectSlug);
  return result;
}

function createPage(projectQuery, { name, html = '', css = '' } = {}) {
  const p = requireProject(projectQuery);
  if (!name) throw new Error('Page name is required');
  let slug = slugify(name);
  let n = 2;
  while (fs.existsSync(pageFile(p.slug, slug))) slug = `${slugify(name)}-${n++}`;
  const { document: doc } = parseHTML('<!doctype html><html lang="en"><head></head><body></body></html>');
  const meta = readJson(path.join(projectDir(p.slug), 'project.json'), {});
  applyHead(doc, meta, name);
  doc.head.querySelector('style#blobby-css').textContent = css || '';
  doc.body.innerHTML = html || '';
  assignIds(doc.body);
  fs.mkdirSync(pagesDir(p.slug), { recursive: true });
  fs.writeFileSync(pageFile(p.slug, slug), serialize(doc));
  touchProject(p.slug);
  return { project: p.slug, page: slug, file: pageFile(p.slug, slug) };
}

function byId(doc, id) {
  const el = doc.querySelector(`[${ID_ATTR}="${String(id).replace(/"/g, '')}"]`);
  if (!el) throw new Error(`No element with id ${id}. Use get_tree to see current ids.`);
  return el;
}

// position: append | prepend | before | after | replace | inner
function writeHtml(projectQuery, pageQuery, { html, targetId, position = 'append' }) {
  const p = requireProject(projectQuery);
  const page = requirePage(p.slug, pageQuery);
  return mutatePage(p.slug, page.slug, (doc) => {
    if (!targetId && ['before', 'after', 'replace'].includes(position)) throw new Error(`position "${position}" needs a target_id`);
    const target = targetId ? byId(doc, targetId) : doc.body;
    const tpl = doc.createElement('template');
    tpl.innerHTML = html;
    const frag = tpl.content || tpl;
    const nodes = Array.from(frag.childNodes);
    // Incoming ids that are still in use elsewhere get fresh ones, so existing elements
    // (and feedback pinned to them) keep theirs. Replacing a node may reuse its old ids.
    const replaced = position === 'replace' ? target : position === 'inner' ? target : null;
    const keep = new Set();
    if (replaced) replaced.querySelectorAll(`[${ID_ATTR}]`).forEach((el) => keep.add(el.getAttribute(ID_ATTR)));
    if (position === 'replace') keep.add(target.getAttribute(ID_ATTR));
    const inUse = new Set(Array.from(doc.querySelectorAll(`[${ID_ATTR}]`)).map((el) => el.getAttribute(ID_ATTR)).filter((id) => !keep.has(id)));
    for (const n of nodes) {
      if (n.nodeType !== 1) continue;
      [n, ...n.querySelectorAll(`[${ID_ATTR}]`)].forEach((el) => { if (inUse.has(el.getAttribute(ID_ATTR))) el.removeAttribute(ID_ATTR); });
      assignIds(n);
    }
    const ids = nodes.filter((n) => n.nodeType === 1).map((n) => n.getAttribute(ID_ATTR));
    const insert = (where) => nodes.forEach((n) => where(n));
    switch (position) {
      case 'prepend': { const first = target.firstChild; insert((n) => target.insertBefore(n, first)); break; }
      case 'before': insert((n) => target.parentNode.insertBefore(n, target)); break;
      case 'after': { const next = target.nextSibling; insert((n) => target.parentNode.insertBefore(n, next)); break; }
      case 'replace': insert((n) => target.parentNode.insertBefore(n, target)); target.remove(); break;
      case 'inner': target.innerHTML = ''; insert((n) => target.appendChild(n)); break;
      default: insert((n) => target.appendChild(n));
    }
    return { project: p.slug, page: page.slug, insertedIds: ids };
  });
}

function setCss(projectQuery, pageQuery, { css, mode = 'append' }) {
  const p = requireProject(projectQuery);
  const page = requirePage(p.slug, pageQuery);
  return mutatePage(p.slug, page.slug, (doc) => {
    const style = doc.head.querySelector('style#blobby-css');
    style.textContent = mode === 'replace' ? css : `${style.textContent || ''}\n${css}`.trim();
    return { project: p.slug, page: page.slug, cssLength: style.textContent.length };
  });
}

function parseStyle(str) {
  const out = {};
  for (const part of String(str || '').split(';')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function updateStyles(projectQuery, pageQuery, { nodeIds, styles }) {
  const p = requireProject(projectQuery);
  const page = requirePage(p.slug, pageQuery);
  return mutatePage(p.slug, page.slug, (doc) => {
    for (const id of nodeIds) {
      const el = byId(doc, id);
      const cur = parseStyle(el.getAttribute('style'));
      for (const [k, v] of Object.entries(styles)) {
        const prop = k.includes('-') || k.startsWith('--') ? k : k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
        if (v === null || v === '') delete cur[prop]; else cur[prop] = String(v);
      }
      const s = Object.entries(cur).map(([k, v]) => `${k}: ${v}`).join('; ');
      if (s) el.setAttribute('style', s); else el.removeAttribute('style');
    }
    return { updated: nodeIds };
  });
}

function setText(projectQuery, pageQuery, { nodeId, text }) {
  const p = requireProject(projectQuery);
  const page = requirePage(p.slug, pageQuery);
  return mutatePage(p.slug, page.slug, (doc) => { byId(doc, nodeId).textContent = text; return { updated: nodeId }; });
}

function setAttributes(projectQuery, pageQuery, { nodeId, attributes }) {
  const p = requireProject(projectQuery);
  const page = requirePage(p.slug, pageQuery);
  return mutatePage(p.slug, page.slug, (doc) => {
    const el = byId(doc, nodeId);
    for (const [k, v] of Object.entries(attributes)) {
      if (k === ID_ATTR) continue;
      if (v === null) el.removeAttribute(k); else el.setAttribute(k, String(v));
    }
    return { updated: nodeId };
  });
}

function deleteNodes(projectQuery, pageQuery, { nodeIds }) {
  const p = requireProject(projectQuery);
  const page = requirePage(p.slug, pageQuery);
  return mutatePage(p.slug, page.slug, (doc) => { nodeIds.forEach((id) => byId(doc, id).remove()); return { deleted: nodeIds }; });
}

function undo(projectQuery, pageQuery) {
  const p = requireProject(projectQuery);
  const page = requirePage(p.slug, pageQuery);
  const dir = path.join(projectDir(p.slug), '.history', page.slug);
  const snaps = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  if (!snaps.length) throw new Error('Nothing to undo');
  const last = path.join(dir, snaps[snaps.length - 1]);
  fs.copyFileSync(last, pageFile(p.slug, page.slug));
  fs.unlinkSync(last);
  // Tokens are project-wide, so an undo must not bring back old ones.
  const meta = readJson(path.join(projectDir(p.slug), 'project.json'), {});
  mutatePage(p.slug, page.slug, (doc) => applyHead(doc, meta), { snapshot: false });
  return { project: p.slug, page: page.slug, remainingUndo: snaps.length - 1 };
}

function getPageHtml(projectQuery, pageQuery, { nodeId } = {}) {
  const p = requireProject(projectQuery);
  const page = requirePage(p.slug, pageQuery);
  const doc = loadDoc(p.slug, page.slug);
  if (nodeId) return byId(doc, nodeId).outerHTML;
  const css = doc.head.querySelector('style#blobby-css');
  return { project: p.slug, page: page.slug, css: css ? css.textContent : '', html: doc.body.innerHTML };
}

// Compact outline so the AI can target elements without reading the whole page.
function getTree(projectQuery, pageQuery, { maxDepth = 8 } = {}) {
  const p = requireProject(projectQuery);
  const page = requirePage(p.slug, pageQuery);
  const doc = loadDoc(p.slug, page.slug);
  const lines = [];
  const walk = (el, depth) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style') continue;
      const cls = child.getAttribute('class') ? '.' + child.getAttribute('class').trim().split(/\s+/).join('.') : '';
      const ownText = Array.from(child.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
      const text = ownText ? ` "${ownText.slice(0, 60)}${ownText.length > 60 ? '…' : ''}"` : '';
      lines.push(`${'  '.repeat(depth)}${tag}${cls} #${child.getAttribute(ID_ATTR)}${text}`);
      if (depth < maxDepth) walk(child, depth + 1);
    }
  };
  walk(doc.body, 0);
  return lines.join('\n') || '(empty page)';
}

// ---------- feedback ----------

function feedbackFile(slug) { return path.join(projectDir(slug), 'feedback.json'); }

function listFeedback(projectQuery, { status = 'open', page } = {}) {
  const projects = projectQuery ? [requireProject(projectQuery)] : listProjects();
  const out = [];
  for (const p of projects) {
    for (const f of readJson(feedbackFile(p.slug), [])) {
      if (status !== 'all' && f.status !== status) continue;
      if (page && f.page !== page) continue;
      const shot = f.screenshot ? (path.isAbsolute(f.screenshot) ? f.screenshot : path.join(projectDir(p.slug), f.screenshot)) : '';
      out.push({ ...f, replies: f.replies || [], project: p.slug, screenshotFile: shot });
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function addFeedback(projectQuery, { page, nodeId, comment, snippet, label, rect, viewport, screenshot, author }) {
  const p = requireProject(projectQuery);
  const items = readJson(feedbackFile(p.slug), []);
  const id = newId('f');
  let shot = '';
  if (screenshot) {
    const dir = path.join(projectDir(p.slug), '.feedback');
    fs.mkdirSync(dir, { recursive: true });
    shot = `.feedback/${id}.png`;
    fs.writeFileSync(path.join(projectDir(p.slug), shot), Buffer.from(screenshot.replace(/^data:image\/png;base64,/, ''), 'base64'));
  }
  const item = {
    id, page, nodeId, comment, snippet: (snippet || '').slice(0, 2000), label: label || '',
    rect: rect || null, viewport: viewport || null, screenshot: shot, author: author || null,
    status: 'open', createdAt: new Date().toISOString(), reply: '', replies: [],
  };
  items.push(item);
  writeJson(feedbackFile(p.slug), items);
  touchProject(p.slug);
  return { ...item, project: p.slug };
}

function updateFeedback(projectQuery, id, patch) {
  const p = requireProject(projectQuery);
  const items = readJson(feedbackFile(p.slug), []);
  const item = items.find((f) => f.id === id);
  if (!item) throw new Error(`No feedback ${id} in ${p.slug}`);
  Object.assign(item, patch, { updatedAt: new Date().toISOString() });
  writeJson(feedbackFile(p.slug), items);
  touchProject(p.slug);
  return { ...item, project: p.slug };
}

// Comment threads: people and the AI reply under a pin.
function addReply(projectQuery, id, { text, author, ai = false, resolve = false, reopen = false }) {
  const p = requireProject(projectQuery);
  const items = readJson(feedbackFile(p.slug), []);
  const item = items.find((f) => f.id === id);
  if (!item) throw new Error(`No feedback ${id} in ${p.slug}`);
  item.replies = item.replies || [];
  item.replies.push({ id: newId('r'), text, author: author || null, ai, createdAt: new Date().toISOString() });
  if (ai) item.reply = text;
  if (resolve) item.status = 'resolved';
  if (reopen) item.status = 'open';
  item.updatedAt = new Date().toISOString();
  writeJson(feedbackFile(p.slug), items);
  touchProject(p.slug);
  return { ...item, project: p.slug };
}

function deleteFeedback(projectQuery, id) {
  const p = requireProject(projectQuery);
  writeJson(feedbackFile(p.slug), readJson(feedbackFile(p.slug), []).filter((f) => f.id !== id));
}

// ---------- managing projects & pages ----------

function trash(dir) {
  const bin = path.join(root(), '.trash');
  fs.mkdirSync(bin, { recursive: true });
  fs.renameSync(dir, path.join(bin, `${path.basename(dir)}-${Date.now()}`));
}

function renameProject(projectQuery, { name, site, description }) {
  const p = requireProject(projectQuery);
  const file = path.join(projectDir(p.slug), 'project.json');
  const meta = readJson(file, {});
  if (name) meta.name = name;
  if (site !== undefined) meta.site = site;
  if (description !== undefined) meta.description = description;
  meta.updatedAt = new Date().toISOString();
  writeJson(file, meta);
  return readProjectMeta(p.slug);
}

function deleteProject(projectQuery) {
  const p = requireProject(projectQuery);
  trash(projectDir(p.slug));
  return { deleted: p.slug };
}

function duplicateProject(projectQuery, { name } = {}) {
  const p = requireProject(projectQuery);
  const newName = name || `${p.name} copy`;
  let slug = slugify(newName);
  let n = 2;
  while (fs.existsSync(projectDir(slug))) slug = `${slugify(newName)}-${n++}`;
  fs.cpSync(projectDir(p.slug), projectDir(slug), { recursive: true, filter: (src) => !/[\\/](\.history|\.feedback)([\\/]|$)/.test(src) });
  writeJson(path.join(projectDir(slug), 'feedback.json'), []);
  const file = path.join(projectDir(slug), 'project.json');
  const meta = readJson(file, {});
  meta.name = newName;
  meta.createdAt = meta.updatedAt = new Date().toISOString();
  writeJson(file, meta);
  return readProjectMeta(slug);
}

function renamePage(projectQuery, pageQuery, { title }) {
  const p = requireProject(projectQuery);
  const page = requirePage(p.slug, pageQuery);
  mutatePage(p.slug, page.slug, (doc) => {
    let t = doc.head.querySelector('title');
    if (!t) { t = doc.createElement('title'); doc.head.appendChild(t); }
    t.textContent = title;
  }, { snapshot: false });
  return { project: p.slug, page: page.slug, title };
}

function duplicatePage(projectQuery, pageQuery, { name } = {}) {
  const p = requireProject(projectQuery);
  const page = requirePage(p.slug, pageQuery);
  const title = name || `${page.title} copy`;
  let slug = slugify(title);
  let n = 2;
  while (fs.existsSync(pageFile(p.slug, slug))) slug = `${slugify(title)}-${n++}`;
  fs.copyFileSync(pageFile(p.slug, page.slug), pageFile(p.slug, slug));
  const brief = readJson(briefFile(p.slug, page.slug), null);
  if (brief) writeJson(briefFile(p.slug, slug), brief);
  renamePage(p.slug, slug, { title });
  return { project: p.slug, page: slug, title };
}

function deletePage(projectQuery, pageQuery) {
  const p = requireProject(projectQuery);
  const page = requirePage(p.slug, pageQuery);
  const bin = path.join(root(), '.trash');
  fs.mkdirSync(bin, { recursive: true });
  fs.renameSync(pageFile(p.slug, page.slug), path.join(bin, `${p.slug}-${page.slug}-${Date.now()}.html`));
  touchProject(p.slug);
  return { deleted: page.slug };
}

// Moves elements (in the given order) relative to a target: before | after | append | prepend.
function moveNodes(projectQuery, pageQuery, { nodeIds, targetId, position = 'after' }) {
  const p = requireProject(projectQuery);
  const page = requirePage(p.slug, pageQuery);
  return mutatePage(p.slug, page.slug, (doc) => {
    const target = byId(doc, targetId);
    const nodes = nodeIds.map((id) => byId(doc, id));
    if (nodes.some((n) => n === target || n.contains(target))) throw new Error('Cannot move an element into itself');
    if (position === 'before') nodes.forEach((n) => target.parentNode.insertBefore(n, target));
    else if (position === 'after') { let ref = target; nodes.forEach((n) => { ref.parentNode.insertBefore(n, ref.nextSibling); ref = n; }); }
    else if (position === 'prepend') { const first = target.firstChild; nodes.forEach((n) => target.insertBefore(n, first)); }
    else nodes.forEach((n) => target.appendChild(n));
    return { moved: nodeIds };
  });
}

function thumbFile(projectSlug, pageSlug) { return path.join(projectDir(projectSlug), '.thumbs', `${pageSlug}.jpg`); }

function saveThumb(projectQuery, pageQuery, base64) {
  const p = requireProject(projectQuery);
  const page = requirePage(p.slug, pageQuery);
  const file = thumbFile(p.slug, page.slug);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(base64, 'base64'));
  return file;
}

// ---------- briefs ----------
// What the client asked for, saved per page so building and QA are checked against it.

function briefFile(slug, page) { return path.join(projectDir(slug), 'briefs', `${page}.json`); }

function getBrief(projectQuery, pageQuery) {
  const p = requireProject(projectQuery);
  const page = requirePage(p.slug, pageQuery);
  return readJson(briefFile(p.slug, page.slug), null);
}

function setBrief(projectQuery, pageQuery, brief) {
  const p = requireProject(projectQuery);
  const page = requirePage(p.slug, pageQuery);
  const prev = readJson(briefFile(p.slug, page.slug), {});
  const next = { ...prev, ...brief, updatedAt: new Date().toISOString() };
  writeJson(briefFile(p.slug, page.slug), next);
  return next;
}

// ---------- export ----------

function exportPage(projectQuery, pageQuery, { dest, keepIds = false } = {}) {
  const p = requireProject(projectQuery);
  const page = requirePage(p.slug, pageQuery);
  const doc = loadDoc(p.slug, page.slug);
  const out = dest || path.join(root(), '_exports', `${p.slug}-${page.slug}`);
  fs.mkdirSync(out, { recursive: true });

  // One stylesheet: base + tokens + page css, in the same cascade order as the canvas.
  const css = ['blobby-base', 'blobby-tokens', 'blobby-css']
    .map((id) => doc.head.querySelector(`style#${id}`))
    .filter(Boolean)
    .map((s) => s.textContent.trim())
    .join('\n\n');
  doc.head.querySelectorAll('style#blobby-base, style#blobby-tokens, style#blobby-css').forEach((s) => s.remove());
  const fonts = doc.head.querySelector('link#blobby-fonts');
  if (fonts) fonts.removeAttribute('id');
  const link = doc.createElement('link');
  link.setAttribute('rel', 'stylesheet');
  link.setAttribute('href', 'styles.css');
  doc.head.appendChild(link);
  if (!keepIds) doc.querySelectorAll(`[${ID_ATTR}]`).forEach((el) => el.removeAttribute(ID_ATTR));

  // Pages live in pages/ and point at ../assets/; the export sits next to its assets/ folder.
  const fixAssets = (s) => s.replace(/\.\.\/assets\//g, 'assets/');
  fs.writeFileSync(path.join(out, 'index.html'), fixAssets(serialize(doc)));
  fs.writeFileSync(path.join(out, 'styles.css'), fixAssets(css) + '\n');
  const assets = path.join(projectDir(p.slug), 'assets');
  if (fs.existsSync(assets) && fs.readdirSync(assets).length) fs.cpSync(assets, path.join(out, 'assets'), { recursive: true });
  return { dir: out, files: fs.readdirSync(out) };
}

function addAsset(projectQuery, { filename, data, sourcePath }) {
  const p = requireProject(projectQuery);
  const dir = path.join(projectDir(p.slug), 'assets');
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(filename || sourcePath).replace(/[^\w.\-]+/g, '-');
  const dest = path.join(dir, name);
  if (sourcePath) fs.copyFileSync(sourcePath, dest);
  else fs.writeFileSync(dest, Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64'));
  return { path: `../assets/${name}`, file: dest };
}

export {
  ROOT, root, withRoot, ID_ATTR, ensureRoot, slugify, projectDir, pageFile,
  listProjects, createProject, findProject, requireProject, setTokens, readProjectMeta,
  listPages, findPage, requirePage, createPage, writeHtml, setCss, updateStyles, setText, setAttributes,
  deleteNodes, undo, getPageHtml, getTree,
  listFeedback, addFeedback, updateFeedback, deleteFeedback, addReply,
  renameProject, deleteProject, duplicateProject, renamePage, duplicatePage, deletePage, moveNodes,
  thumbFile, saveThumb,
  exportPage, addAsset, getBrief, setBrief,
};
