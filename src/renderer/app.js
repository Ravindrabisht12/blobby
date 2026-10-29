import { DEVICES } from '../shared/preview.js';
import { api } from './api.js';
import { ICON, BRAND } from './icons.js';

const $ = (sel, root = document) => root.querySelector(sel);
const ID = 'data-b-id';
const GAP = 120;
const DEVICE_ORDER = ['desktop', 'tablet', 'mobile'];
const REPO_URL = 'https://github.com/Ravindrabisht12/blobby';
const TEXT_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'span', 'a', 'br', 'small', 'mark', 'sup', 'sub', 'code']);
const VOID_TAGS = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'source', 'track', 'wbr', 'area', 'col', 'embed']);

const saved = (key, fallback) => { try { const v = localStorage.getItem('blobby.' + key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem('blobby.' + key, JSON.stringify(value)); } catch { /* storage unavailable */ } };

const state = {
  view: 'home',
  homeProject: null,
  search: '',
  projects: [],
  feedbackCounts: {},
  project: null,
  page: null,
  devices: saved('devices', ['desktop', 'mobile']),
  mode: 'select',
  zoom: 1,
  pan: { x: 60, y: 70 },
  sel: [], // selected element ids, last one is primary
  selDevice: 'desktop',
  feedback: [],
  tab: 'inspect',
  follow: saved('follow', true),
  editing: null,
  space: false,
  expanded: new Set(),
  activeThread: null,
  showResolved: false,
  clipboard: '',
  thumbVersion: {},
  leftOpen: saved('leftOpen', true),
  rightOpen: saved('rightOpen', true),
  appInfo: null,
  tabs: saved('tabs', []), // open pages in the tab bar: [{ project, page }]
  homeSection: 'recents', // recents | projects | project | settings
  settingsTab: null,
  dashView: saved('dashView', 'grid'),
  promoHidden: saved('promoHidden', false),
  commentArm: false, // comment tool: the next click on an element opens the composer
};


// Shortcut hints are written Mac-style (⌘ ⌥ ⇧ ⌫). Keyboard handling already accepts Ctrl for ⌘;
// on Windows and Linux every hint the UI shows is rewritten to Ctrl / Alt / Shift as it appears.
const IS_MAC = /Mac/.test(navigator.platform);
const KEY_WORDS = { '⌘': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift', '⌫': 'Backspace' };
const keyText = (s) => s
  .replace(/([⌘⌥⇧⌫])(?=$|[\s)<])/g, (_, c) => KEY_WORDS[c]) // a key on its own: "⌘" → "Ctrl"
  .replace(/[⌘⌥⇧⌫]/g, (c) => `${KEY_WORDS[c]}+`); // a modifier before a key: "⌘C" → "Ctrl+C"

function localizeKeys(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    if (/[⌘⌥⇧⌫]/.test(node.data)) node.data = keyText(node.data);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  for (const el of [node, ...node.querySelectorAll('[title]')]) {
    const t = el.getAttribute?.('title');
    if (t && /[⌘⌥⇧⌫]/.test(t)) el.setAttribute('title', keyText(t));
  }
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) if (/[⌘⌥⇧⌫]/.test(walker.currentNode.data)) walker.currentNode.data = keyText(walker.currentNode.data);
}

function watchKeyLabels() {
  if (IS_MAC) return;
  localizeKeys(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach(localizeKeys);
      else localizeKeys(m.target);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title'] });
}

const boards = new Map(); // device -> { device, el, wrap, shield, iframe }

// ---------- utils ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg, { error = false, ms = 2600 } = {}) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

async function run(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (err) {
    toast(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), { error: true, ms: 4000 });
    return undefined;
  }
}

const store = (method, ...args) => api.store(method, ...args);
const current = () => state.projects.find((p) => p.slug === state.project) || null;
const currentPage = () => current()?.pages.find((p) => p.slug === state.page) || null;
const primary = () => state.sel[state.sel.length - 1] || null;

function rgbToHex(v) {
  const m = String(v).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
  if (!m) return /^#[0-9a-f]{3,8}$/i.test(String(v).trim()) ? String(v).trim() : '#000000';
  if (m[4] !== undefined && Number(m[4]) === 0) return 'transparent';
  return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
}

function describe(el) {
  if (!el) return '';
  const tag = el.tagName.toLowerCase();
  const cls = el.getAttribute('class') ? '.' + el.getAttribute('class').trim().split(/\s+/)[0] : '';
  const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return `${tag}${cls}${txt ? ` “${txt}${txt.length >= 40 ? '…' : ''}”` : ''}`;
}

function timeAgo(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function avatar(user, cls = '') {
  if (!user) return `<span class="av ${cls}" style="background:#636363">Y</span>`;
  const initials = String(user.name || user.email || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return `<span class="av ${cls}" style="background:${esc(user.color || '#636363')}" title="${esc(user.name)}">${esc(initials)}</span>`;
}

const ic = (name, size = 16) => (ICON[name] || '').replace('<svg', `<svg width="${size}" height="${size}" aria-hidden="true" focusable="false"`);
const brandIcon = (name, size = 20) => {
  const b = BRAND[name];
  return b ? b.svg.replace('<svg ', `<svg width="${size}" height="${size}" style="color:#${b.hex === '000000' || b.hex === '0B100F' ? '111' : b.hex}" aria-hidden="true" `) : '';
};

const ICONS = {
  text: ic('type', 13), image: ic('image', 13), link: ic('link', 13), button: ic('rectangle-horizontal', 13),
  frame: ic('frame', 13), section: ic('rows-3', 13), row: ic('columns-3', 13), stack: ic('rows-3', 13), gridbox: ic('layout-grid', 13), shape: ic('triangle', 13), input: ic('text-cursor-input', 13),
  caret: ic('chevron-right', 11), more: ic('ellipsis', 16), folder: ic('folder', 15), page: ic('file', 15), search: ic('search', 15),
  cursor: (color) => `<svg viewBox="0 0 18 18"><path d="M2 1.5l13 6.2-5.6 1.6L7 15z" fill="${color}" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
};

// Static markup declares icons as data-icon="name"; fill them once at startup.
function fillIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.querySelector(':scope > svg')) return;
    el.insertAdjacentHTML('afterbegin', ic(el.dataset.icon, Number(el.dataset.size) || 16));
  });
}

function kindOf(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'img' || tag === 'picture' || tag === 'video') return 'image';
  if (tag === 'svg') return 'shape';
  if (tag === 'button' || /\bbtn\b|button/.test(el.getAttribute('class') || '')) return 'button';
  if (tag === 'a') return 'link';
  if (['input', 'textarea', 'select'].includes(tag)) return 'input';
  if (['section', 'header', 'footer', 'nav', 'main', 'article', 'aside', 'form'].includes(tag)) return 'section';
  if (isTextOnly(el) || /^(h[1-6]|p|span|li|label|small|strong|em|blockquote)$/.test(tag)) return 'text';
  // Layout containers show their direction, like auto-layout frames.
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (cs?.display.includes('flex')) return cs.flexDirection.startsWith('column') ? 'stack' : 'row';
  if (cs?.display.includes('grid')) return 'gridbox';
  return 'frame';
}

function layerName(el) {
  const tag = el.tagName.toLowerCase();
  const kind = kindOf(el);
  const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if ((kind === 'text' || kind === 'button' || kind === 'link') && txt && isTextOnly(el)) return txt.slice(0, 48);
  const cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
  if (cls) return cls.replace(/[-_]/g, ' ');
  if (tag === 'img') return el.getAttribute('alt') || 'Image';
  return { section: 'Section', header: 'Header', footer: 'Footer', nav: 'Nav', main: 'Main', div: 'Frame', ul: 'List', li: 'Item', form: 'Form', svg: 'Vector' }[tag] || tag;
}

// ---------- menus & modals ----------

function showMenu(x, y, items) {
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => {
    if (it === '-') return '<hr>';
    if (it.html) return it.html;
    if (it.heading) return `<div class="label">${esc(it.label)}</div>`;
    return `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${'icon' in it ? `<span class="mi">${it.icon ? ic(it.icon, 15) : ''}</span>` : ''}<span class="lbl2">${esc(it.label)}</span>${it.k ? `<span class="k">${esc(it.k)}</span>` : ''}</button>`;
  }).join('');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  m.onclick = (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    hideMenu();
    items[Number(b.dataset.i)].action?.();
  };
}
function hideMenu() { $('#menu').hidden = true; }

function modal(html) {
  $('#modal').className = 'modal';
  $('#modal').removeAttribute('style');
  $('#modal').innerHTML = html;
  $('#modalBack').hidden = false;
  setTimeout(() => $('#modal input')?.focus(), 0);
  return $('#modal');
}
function closeModal() { $('#modalBack').hidden = true; $('#modal').innerHTML = ''; }

function formModal({ title, sub, fields, okLabel = 'Create' }) {
  return new Promise((resolve) => {
    const m = modal(`<h2>${esc(title)}</h2>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}
      <form class="stack">${fields.map((f) => `<label class="lbl">${esc(f.label)}<input class="input" name="${f.name}" placeholder="${esc(f.placeholder || '')}" value="${esc(f.value || '')}"></label>`).join('')}
      <div class="foot"><button type="button" class="btn light" data-cancel>Cancel</button><button class="btn primary">${esc(okLabel)}</button></div></form>`);
    m.querySelector('[data-cancel]').onclick = () => { closeModal(); resolve(null); };
    m.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target));
      closeModal();
      resolve(data);
    };
  });
}

function confirmModal({ title, sub, okLabel = 'Delete' }) {
  return new Promise((resolve) => {
    const m = modal(`<h2>${esc(title)}</h2>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}
      <div class="foot"><button class="btn light" data-cancel>Cancel</button><button class="btn primary" data-ok style="background:#c42b2b;border-color:#a32323;color:#fff">${esc(okLabel)}</button></div>`);
    m.querySelector('[data-cancel]').onclick = () => { closeModal(); resolve(false); };
    m.querySelector('[data-ok]').onclick = () => { closeModal(); resolve(true); };
    setTimeout(() => m.querySelector('[data-ok]').focus(), 0);
  });
}

// ---------- data ----------

async function refreshProjects() {
  state.projects = (await run(() => store('listProjects'))) || [];
  const fb = (await run(() => store('listFeedback', null, { status: 'open' }))) || [];
  state.feedbackCounts = fb.reduce((acc, f) => ({ ...acc, [f.project]: (acc[f.project] || 0) + 1 }), {});
  if (state.project && !current()) { state.project = null; state.page = null; if (state.view === 'editor') setView('home'); }
  if (state.project && state.page && !currentPage()) state.page = current().pages.at(-1)?.slug || null;
  if (state.homeProject && !state.projects.some((p) => p.slug === state.homeProject)) state.homeProject = null;
  renderSidebar();
  renderTabs();
  if (state.view === 'home') renderDash();
}

async function loadFeedback() {
  state.feedback = state.project ? ((await run(() => store('listFeedback', state.project, { status: 'all' }))) || []) : [];
  const open = state.feedback.filter((f) => f.status === 'open').length;
  $('#fbCount').hidden = !open;
  $('#fbCount').textContent = open;
  drawOverlays();
  if (state.tab === 'feedback' && !panelHasFocus()) renderFeedback();
}

function setView(view) {
  state.view = view;
  $('#app').classList.toggle('view-home', view === 'home');
  $('#app').classList.toggle('view-editor', view === 'editor');
  if (view === 'home') {
    renderDash();
  }
  renderSidebar();
  renderTabs();
  save('last', { view, project: state.project, page: state.page, homeProject: state.homeProject });
}

async function openProject(slug, page) {
  const changedProject = slug !== state.project;
  if (!state.projects.find((p) => p.slug === slug)) await refreshProjects();
  const p = state.projects.find((x) => x.slug === slug);
  if (!p) return;
  const nextPage = page && p.pages.find((x) => x.slug === page) ? page : (changedProject || !state.page ? p.pages.at(-1)?.slug || null : state.page);
  const changedPage = nextPage !== state.page || changedProject || state.view !== 'editor';
  state.project = slug;
  state.page = nextPage;
  state.homeProject = slug;
  state.homeSection = 'project';
  if (nextPage && !state.tabs.some((t) => t.project === slug && t.page === nextPage)) {
    state.tabs.push({ project: slug, page: nextPage });
    if (state.tabs.length > 8) state.tabs.shift();
  }
  if (changedPage) { state.sel = []; state.expanded = new Set(); api.selectionChanged(null); }
  setView('editor');
  await loadFeedback();
  if (changedPage) { renderBoards(); renderPanel(); renderLayers(); }
}

// Home has sections (recents, projects, one project, settings). Without a project we stay in the
// current section, except a project view falls back to recents.
function goHome(projectSlug = null, section = null) {
  state.homeProject = projectSlug;
  state.homeSection = projectSlug ? 'project' : (section || (state.homeSection === 'project' ? 'recents' : state.homeSection));
  state.sel = [];
  setView('home');
}

function openSettings(tab = null) {
  state.settingsTab = tab;
  goHome(null, 'settings');
}

function closeTab(project, page) {
  const i = state.tabs.findIndex((t) => t.project === project && t.page === page);
  if (i < 0) return;
  state.tabs.splice(i, 1);
  save('tabs', state.tabs);
  const active = state.view === 'editor' && state.project === project && state.page === page;
  if (!active) return renderTabs();
  const next = state.tabs[i] || state.tabs[i - 1];
  if (next) openProject(next.project, next.page);
  else goHome(project);
}

// ---------- top bar & sidebar ----------

function renderTabs() {
  if (state.projects.length || !state.tabs.length) {
    state.tabs = state.tabs.filter((t) => state.projects.find((p) => p.slug === t.project)?.pages.some((pg) => pg.slug === t.page));
    save('tabs', state.tabs);
  }
  $('#homeTab').classList.toggle('on', state.view === 'home');
  $('#openTabs').innerHTML = state.tabs.map((t) => {
    const p = state.projects.find((x) => x.slug === t.project);
    const pg = p?.pages.find((x) => x.slug === t.page);
    if (!pg) return '';
    const on = state.view === 'editor' && t.project === state.project && t.page === state.page;
    return `<div class="tab${on ? ' on' : ''}" role="tab" tabindex="0" aria-selected="${on}" data-tab-project="${esc(t.project)}" data-tab-page="${esc(t.page)}" title="${esc(p.name)} / ${esc(pg.title)}">
      ${ic('file', 14)}<span class="tl">${esc(pg.title)}</span><span class="tx" data-close-tab role="button" aria-label="Close tab" title="Close tab">${ic('x', 12)}</span></div>`;
  }).join('');
}

const DEV_ICON = { desktop: 'monitor', tablet: 'tablet', mobile: 'smartphone' };

function renderToolbar() {
  const active = state.commentArm ? 'comment' : state.mode;
  document.querySelectorAll('#rail [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === active));
  document.querySelectorAll('[data-devices]').forEach((box) => {
    box.innerHTML = DEVICE_ORDER.map((d) => `<button data-device="${d}" class="${state.devices.includes(d) ? 'on' : ''}" title="${state.devices.includes(d) ? 'Hide' : 'Show'} ${DEVICES[d].label} artboard (${DEVICES[d].width}px)">${ic(DEV_ICON[d], 14)}${DEVICES[d].label}</button>`).join('');
  });
  $('#app').classList.toggle('mode-interact', state.mode === 'interact');
  $('#app').classList.toggle('mode-hand', state.mode === 'hand');
  $('#followAi').checked = state.follow;
}

function toggleDevice(d) {
  const next = state.devices.includes(d) ? state.devices.filter((x) => x !== d) : [...state.devices, d];
  if (!next.length) { toast('Keep at least one artboard'); return; }
  state.devices = DEVICE_ORDER.filter((x) => next.includes(x));
  save('devices', state.devices);
  renderToolbar();
  if (state.view === 'editor') renderBoards();
}

function zoomMenu() {
  const r = $('#zoomBtn').getBoundingClientRect();
  const c = $('#canvas').getBoundingClientRect();
  const center = [c.left + c.width / 2, c.top + c.height / 2];
  showMenu(r.right - 220, r.bottom + 4, [
    { label: 'Zoom in', icon: 'zoom-in', k: '⌘+', action: () => zoomAt(...center, 1.2) },
    { label: 'Zoom out', icon: 'zoom-out', k: '⌘−', action: () => zoomAt(...center, 1 / 1.2) },
    { label: 'Zoom to fit', icon: 'scan', k: '⌘0', action: fit },
    { label: 'Zoom to 50%', icon: '', action: () => zoomAt(...center, 0.5 / state.zoom) },
    { label: 'Zoom to 100%', icon: '', action: () => zoomAt(...center, 1 / state.zoom) },
    '-',
    { heading: true, label: 'Artboards' },
    ...DEVICE_ORDER.map((d) => ({ label: `${DEVICES[d].label} · ${DEVICES[d].width}px`, icon: state.devices.includes(d) ? 'check' : '', action: () => toggleDevice(d) })),
  ]);
}

// Tools in the rail. Insert tools add a starter element after the selection (or inside a selected container).
const INSERTS = {
  text: '<p style="margin:0;font-size:18px;line-height:1.5">Write something</p>',
  box: '<div style="width:240px;height:140px;background:#f1f1f1;border-radius:12px"></div>',
  button: '<a href="#" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#191919;color:#fff;font-weight:600;text-decoration:none">Button</a>',
};

async function insertElement(kind) {
  if (!state.page) { toast('Open a page first'); return; }
  let html = INSERTS[kind];
  if (kind === 'image') {
    const a = await run(() => api.addAsset(state.project));
    if (!a) return;
    html = `<img src="${esc(a.path)}" alt="" style="display:block;max-width:100%;height:auto">`;
  }
  const el = selectedEl();
  const container = el && !isTextOnly(el) && !VOID_TAGS.has(el.tagName.toLowerCase()) && [...el.children].some((c) => c.getAttribute(ID));
  const opts = el ? { html, targetId: primary(), position: container ? 'append' : 'after' } : { html };
  const r = await run(() => store('writeHtml', state.project, state.page, opts));
  setMode('select');
  if (r?.insertedIds?.length) setTimeout(() => select(r.insertedIds, state.selDevice), 350);
}

function useTool(tool) {
  if (tool === 'comment') {
    if (state.sel.length) { state.commentArm = false; openComposer(); }
    else { state.commentArm = !state.commentArm; if (state.commentArm) toast('Click an element to comment on it'); }
    renderToolbar();
    return;
  }
  state.commentArm = false;
  setMode(tool);
}

function renderSidebar() {
  const pl = $('#projectList');
  pl.innerHTML = state.projects.length
    ? state.projects.map((p) => `<li><button data-project="${esc(p.slug)}" class="${p.slug === state.homeProject ? 'active' : ''}">
        <span class="ico">${ICONS.folder}</span><span class="name">${esc(p.name)}</span>
        ${state.feedbackCounts[p.slug] ? `<span class="badge" title="Open comments">${state.feedbackCounts[p.slug]}</span>` : `<span class="meta">${p.pages.length}</span>`}
      </button></li>`).join('')
    : '<li class="none">No projects yet</li>';
  document.querySelectorAll('.side-home [data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === state.homeSection));
  $('#projectList').querySelectorAll('[data-project]').forEach((b) => b.classList.toggle('active', state.homeSection === 'project' && b.dataset.project === state.homeProject));

  const p = current();
  $('#pageList').innerHTML = p
    ? (p.pages.length
      ? [...p.pages].reverse().map((pg) => `<li><button data-page="${esc(pg.slug)}" class="${pg.slug === state.page ? 'active' : ''}">
          <span class="ico">${ICONS.page}</span><span class="name">${esc(pg.title)}</span></button></li>`).join('')
      : '<li class="none">No pages yet</li>')
    : '';
  $('#projName').textContent = p?.name || '';
  $('#revealBtn').disabled = !p;
  $('#exportBtn').disabled = !state.page;
  renderWorkspace();
  renderPromo();
}

function renderPromo() {
  const box = $('#promo');
  box.hidden = state.promoHidden;
  if (state.promoHidden) return;
  box.innerHTML = `<div class="ph"><b>Connect your AI</b><button class="icon-btn" data-promo="hide" title="Hide" aria-label="Hide">${ic('minus', 14)}</button></div>
    <p>Let Claude, Cursor, Codex or any MCP app design here while you watch.</p>
    <button class="btn small" data-promo="connect">${ic('plug', 14)} Connect AI</button>`;
}

function renderWorkspace() {
  $('#wsBox').innerHTML = `<div class="ws-btn static" title="${esc(state.appInfo?.root || '')}"><span class="ws-mark">${ic('monitor', 13)}</span><span class="name">${IS_MAC ? 'On this Mac' : 'On this computer'}</span><span class="role">Local</span></div>`;
}

// ---------- panels ----------

function applyPanels() {
  const app = $('#app');
  app.classList.toggle('hide-left', !state.leftOpen);
  app.classList.toggle('hide-right', !state.rightOpen);
  $('#toggleLeft').title = `${state.leftOpen ? 'Hide' : 'Show'} sidebar (⌥⌘1)`;
  $('#toggleRight').title = `${state.rightOpen ? 'Hide' : 'Show'} panel (⌥⌘2)`;
  save('leftOpen', state.leftOpen);
  save('rightOpen', state.rightOpen);
  requestAnimationFrame(() => { applyTransform(); drawOverlays(); });
}

function togglePanel(which) {
  if (which === 'left') state.leftOpen = !state.leftOpen;
  else if (which === 'right') state.rightOpen = !state.rightOpen;
  else {
    const anyOpen = state.leftOpen || state.rightOpen;
    state.leftOpen = !anyOpen;
    state.rightOpen = !anyOpen;
  }
  applyPanels();
}

// ---------- account ----------

function renderAccount() {
  $('#accountBtn').innerHTML = `<span class="local">${ic('user', 15)}</span>`;
  $('#meRow').innerHTML = `<span class="av" style="background:var(--ink-4)">${ic('monitor', 11)}</span><span class="name">Blobby</span>${ic('chevron-down', 14)}`;
  renderPromo();
}

function accountMenu(anchor = $('#accountBtn')) {
  const r = anchor.getBoundingClientRect();
  showMenu(anchor.id === 'meRow' ? r.left : r.right - 240, r.bottom + 6, [
    { html: `<div class="who"><span class="av" style="background:var(--ink)">${ic('monitor', 15)}</span><div><b>Blobby</b><span>Local projects · v${esc(state.appInfo?.version || '')}</span></div></div>` },
    '-',
    { label: 'Settings', icon: 'settings', k: '⌘,', action: () => openSettings('general') },
    { label: 'Connect AI', icon: 'plug', action: connectModal },
    { label: 'Open Blobby folder', icon: 'folder-open', action: () => api.revealRoot?.() },
    '-',
    { label: 'Keyboard shortcuts', icon: 'keyboard', k: '⌘/', action: shortcutsModal },
    { label: 'Help & getting started', icon: 'circle-help', action: helpModal },
    { label: 'About Blobby', icon: 'info', action: () => openSettings('about') },
  ]);
}

const toggle = (key, on) => `<label class="switch"><input type="checkbox" data-pref="${key}" ${on ? 'checked' : ''}><span></span></label>`;

// Settings is a page on Home, with tabs along the top.
const SETTINGS_TABS = [['general', 'General'], ['canvas', 'Preferences'], ['ai', 'AI connections'], ['about', 'About']];

function settingsPane(active) {
  switch (active) {
    case 'general': return `<h3>General</h3><p class="sub">Blobby keeps everything as plain folders on this computer.</p>
      <div class="group">
        <div class="item"><div class="t"><b>Projects folder</b><span>${esc(state.appInfo?.root || '')}</span></div><button class="btn light small" data-do="reveal-root">${ic('folder-open', 14)} Open</button></div>
        <div class="item"><div class="t"><b>Follow AI edits</b><span>Jump to the page your AI is working on</span></div>${toggle('follow', state.follow)}</div>
      </div>`;
    case 'canvas': return `<h3>Preferences</h3><p class="sub">Saved on this device.</p>
      <div class="group">
        ${DEVICE_ORDER.map((d) => `<div class="item"><div class="t"><b>${DEVICES[d].label} artboard</b><span>${DEVICES[d].width} × ${DEVICES[d].height}px</span></div>${toggle(`device:${d}`, state.devices.includes(d))}</div>`).join('')}
        <div class="item"><div class="t"><b>Follow AI edits</b><span>Jump to the page your AI is working on</span></div>${toggle('follow', state.follow)}</div>
        <div class="item"><div class="t"><b>Sidebar</b><span>Pages and layers (⌥⌘1)</span></div>${toggle('left', state.leftOpen)}</div>
        <div class="item"><div class="t"><b>Design panel</b><span>Design and comments (⌥⌘2)</span></div>${toggle('right', state.rightOpen)}</div>
      </div>`;
    case 'ai': return `<h3>AI connections</h3><p class="sub">Blobby works with any app that supports MCP: Claude, ChatGPT, Codex, Cursor, VS Code, Gemini and more.</p>
      <div class="group">
        <div class="item"><div class="t"><b>Connect an agent</b><span>Step-by-step setup for each app</span></div><button class="btn primary small" data-do="connect">${ic('plug', 14)} Connect AI</button></div>
      </div>`;
    case 'about': return `<div style="text-align:center;padding:24px 0"><img src="mascot.svg" alt="" width="96" height="96">
      <h3 style="margin-top:12px">Blobby</h3><p class="sub" style="margin-bottom:6px">Design with your AI, in real HTML + CSS.</p>
      <p class="hint">${state.appInfo?.version ? `Version ${esc(state.appInfo.version)} · ` : ''}MIT License · © Ravindra Bisht</p>
      <div class="actions" style="justify-content:center"><button class="btn light small" data-do="shortcuts">${ic('keyboard', 14)} Keyboard shortcuts</button><button class="btn light small" data-do="help">${ic('circle-help', 14)} Getting started</button><button class="btn light small" data-do="github">${ic('code', 14)} Source code</button></div></div>`;
    default: return '';
  }
}

function renderSettings(d) {
  if (!SETTINGS_TABS.some((t) => t[0] === state.settingsTab)) state.settingsTab = SETTINGS_TABS[0][0];
  d.innerHTML = `<div class="settings-page"><h1>Settings</h1>
    <nav class="utabs" role="tablist">${SETTINGS_TABS.map(([id, label]) => `<button data-stab="${id}" role="tab" class="${id === state.settingsTab ? 'on' : ''}">${label}</button>`).join('')}</nav>
    <div class="spane">${settingsPane(state.settingsTab)}</div></div>`;
  const page = d.firstElementChild;
  page.onclick = (e) => {
    const tab = e.target.closest('[data-stab]');
    if (tab) { state.settingsTab = tab.dataset.stab; return renderSettings(d); }
    const act = e.target.closest('[data-do]')?.dataset.do;
    if (act === 'connect') return connectModal();
    if (act === 'shortcuts') return shortcutsModal();
    if (act === 'help') return helpModal();
    if (act === 'reveal-root') return api.revealRoot?.();
    if (act === 'github') return api.openExternal(REPO_URL);
    return undefined;
  };
  page.onchange = (e) => {
    const pref = e.target.dataset.pref;
    if (!pref) return;
    const on = e.target.checked;
    if (pref === 'follow') { state.follow = on; save('follow', on); renderToolbar(); }
    if (pref === 'left') { state.leftOpen = on; applyPanels(); }
    if (pref === 'right') { state.rightOpen = on; applyPanels(); }
    if (pref.startsWith('device:')) {
      const dev = pref.slice(7);
      if (on !== state.devices.includes(dev)) toggleDevice(dev);
      e.target.checked = state.devices.includes(dev);
    }
  };
}

const SHORTCUTS = [
  ['Tools', [['Select', ['V']], ['Hand (pan)', ['H']], ['Interact (try links, hovers)', ['P']], ['Add text', ['T']], ['Add box', ['R']], ['Comment', ['C']], ['Pan the canvas', ['Space', 'drag']], ['Zoom to fit', ['⌘', '0']], ['Zoom in / out', ['⌘', '+ / −']]]],
  ['Selection', [['Add to selection', ['⇧', 'click']], ['Select first child', ['↵']], ['Select parent', ['⇧', '↵']], ['Next / previous sibling', ['Tab']], ['Deselect / parent', ['Esc']], ['Edit text', ['Double-click']]]],
  ['Editing', [['Copy / cut / paste', ['⌘', 'C X V']], ['Duplicate', ['⌘', 'D']], ['Delete', ['⌫']], ['Move up / down', ['⌥', '↑ ↓']], ['Nudge (absolute)', ['←↑→↓']], ['Undo', ['⌘', 'Z']], ['Step a value ×10', ['⇧', '↑ ↓']]]],
  ['App', [['Search (Home)', ['⌘', 'F']], ['Toggle sidebar', ['⌥', '⌘', '1']], ['Toggle design panel', ['⌥', '⌘', '2']], ['Hide both panels', ['⌘', '\\']], ['Export HTML + CSS', ['⌘', 'E']], ['New page', ['⌘', 'N']], ['Settings', ['⌘', ',']], ['This list', ['⌘', '/']]]],
];

function shortcutsModal() {
  const m = modal(`<button class="tb-icon close-x" data-close aria-label="Close" style="color:var(--muted)">${ic('x', 16)}</button>
    <h2>Keyboard shortcuts</h2><p class="sub">Work faster on the canvas.</p>
    <div class="keys">${SHORTCUTS.map(([group, rows]) => `<h4>${esc(group)}</h4>${rows.map(([label, keys]) => `<div><span>${esc(label)}</span><span>${keys.map((k) => `<kbd>${esc(k)}</kbd>`).join('')}</span></div>`).join('')}`).join('')}</div>`);
  m.classList.add('wide');
  m.style.padding = '22px 24px';
  m.querySelector('[data-close]').onclick = closeModal;
}

function helpModal() {
  const steps = [
    ['plug', 'Connect your AI', 'Use Connect AI to add Blobby to Claude, ChatGPT, Cursor or any MCP app.'],
    ['sparkles', 'Ask for a design', '“Create a landing page for acme.com in Blobby.” Your AI studies the real site, writes a brief, builds section by section and checks its work.'],
    ['message-square', 'Comment on anything', 'Select an element, press C and say what should change. Then tell your AI: “Apply my Blobby feedback.”'],
    ['pencil', 'Tweak it yourself', 'Drag to reorder, resize with handles, and edit text, spacing, colors and layout in the Design panel.'],
    ['download', 'Export', 'Get clean index.html + styles.css with ⌘E.'],
  ];
  const m = modal(`<button class="tb-icon close-x" data-close aria-label="Close" style="color:var(--muted)">${ic('x', 16)}</button>
    <div style="display:flex;gap:14px;align-items:center;margin-bottom:16px"><img src="mascot.svg" alt="" width="52" height="52"><div><h2 style="margin:0">Getting started</h2><p class="sub" style="margin:2px 0 0">Five steps from idea to clean code.</p></div></div>
    <div class="clients">${steps.map(([icon, t, d], i) => `<div class="client"><span class="logo" style="color:var(--primary)">${ic(icon, 18)}</span><div class="t"><b>${i + 1}. ${esc(t)}</b><span>${esc(d)}</span></div></div>`).join('')}</div>
    <div class="foot"><button class="btn light" data-keys>${ic('keyboard', 14)} Shortcuts</button><button class="btn primary" data-connect>${ic('plug', 14)} Connect AI</button></div>`);
  m.classList.add('wide');
  m.style.padding = '22px 24px';
  m.querySelector('[data-close]').onclick = closeModal;
  m.querySelector('[data-keys]').onclick = shortcutsModal;
  m.querySelector('[data-connect]').onclick = connectModal;
}

// ---------- dashboard ----------

function thumbUrl(project, page) {
  const v = `${Date.parse(page.updatedAt) || 0}-${state.thumbVersion[`${project}/${page.slug}`] || 0}`;
  return api.fileUrl(project, `.thumbs/${page.slug}.jpg`, `v=${v}`);
}

function thumbImg(project, page) {
  return page ? `<img data-thumb src="${esc(thumbUrl(project, page))}" alt="" loading="lazy">` : '<img class="ph" src="logo.svg" alt="">';
}
const latestPage = (p) => [...p.pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

function pageCard(p, pg, { showProject = false } = {}) {
  return `<div class="card" tabindex="0" data-open-project="${esc(p.slug)}" data-open-page="${esc(pg.slug)}">
    <div class="card-head"><div class="t"><b>${esc(pg.title)}</b><span>${showProject ? `${esc(p.name)} · ` : ''}Edited ${timeAgo(pg.updatedAt)}</span></div>
      <button class="more" data-page-menu="${esc(pg.slug)}" data-project="${esc(p.slug)}" title="More" aria-label="More">${ICONS.more}</button></div>
    <div class="thumb">${thumbImg(p.slug, pg)}</div>
  </div>`;
}

function projectCard(p) {
  const open = state.feedbackCounts[p.slug];
  return `<div class="card" tabindex="0" data-home-project="${esc(p.slug)}">
    <div class="card-head"><div class="t"><b>${esc(p.name)}</b><span>${p.pages.length} page${p.pages.length === 1 ? '' : 's'} · Edited ${timeAgo(p.updatedAt)}</span></div>
      ${open ? `<span class="badge" title="Open comments">${open}</span>` : ''}
      <button class="more" data-project-menu="${esc(p.slug)}" title="More" aria-label="More">${ICONS.more}</button></div>
    <div class="thumb">${thumbImg(p.slug, latestPage(p))}</div>
  </div>`;
}

// List view rows: pages show their project, projects show their page count.
function rowsView(items) {
  const row = (it) => it.pg
    ? `<div class="rowi" tabindex="0" data-open-project="${esc(it.p.slug)}" data-open-page="${esc(it.pg.slug)}"><span class="mini">${thumbImg(it.p.slug, it.pg)}</span>
        <b>${esc(it.pg.title)}</b><span>${esc(it.p.name)}</span><span>${timeAgo(it.pg.updatedAt)}</span>
        <button class="more" data-page-menu="${esc(it.pg.slug)}" data-project="${esc(it.p.slug)}" title="More" aria-label="More">${ICONS.more}</button></div>`
    : `<div class="rowi" tabindex="0" data-home-project="${esc(it.p.slug)}"><span class="mini">${thumbImg(it.p.slug, latestPage(it.p))}</span>
        <b>${esc(it.p.name)}</b><span>${it.p.pages.length} page${it.p.pages.length === 1 ? '' : 's'}${state.feedbackCounts[it.p.slug] ? ` · ${state.feedbackCounts[it.p.slug]} open comments` : ''}</span><span>${timeAgo(it.p.updatedAt)}</span>
        <button class="more" data-project-menu="${esc(it.p.slug)}" title="More" aria-label="More">${ICONS.more}</button></div>`;
  return `<div class="rows"><div class="rowi head"><span></span><span>Name</span><span>${items[0]?.pg ? 'Project' : 'Contents'}</span><span>Edited</span><span></span></div>${items.map(row).join('')}</div>`;
}

function itemsView(items) {
  if (state.dashView === 'list') return rowsView(items);
  return `<div class="grid">${items.map((it) => (it.pg ? pageCard(it.p, it.pg, { showProject: it.showProject }) : projectCard(it.p))).join('')}</div>`;
}

const viewToggle = () => `<div class="view-toggle" role="group" aria-label="View">
  <button data-view="grid" class="${state.dashView === 'grid' ? 'on' : ''}" title="Grid" aria-label="Grid view">${ic('layout-grid', 15)}</button>
  <button data-view="list" class="${state.dashView === 'list' ? 'on' : ''}" title="List" aria-label="List view">${ic('list', 15)}</button></div>`;

function renderDash() {
  const d = $('#dash');
  if (state.homeSection === 'settings') return renderSettings(d);
  const q = state.search.trim().toLowerCase();
  const hp = state.homeSection === 'project' ? state.projects.find((x) => x.slug === state.homeProject) : null;
  const allPages = state.projects.flatMap((p) => p.pages.map((pg) => ({ p, pg, showProject: true })))
    .sort((a, b) => b.pg.updatedAt.localeCompare(a.pg.updatedAt));
  let html;

  if (q) {
    const pages = allPages.filter(({ p, pg }) => pg.title.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
    const projects = state.projects.filter((p) => p.name.toLowerCase().includes(q) || (p.site || '').toLowerCase().includes(q)).map((p) => ({ p }));
    html = `<div class="dash-head"><h1>Results for “${esc(state.search.trim())}”</h1>${viewToggle()}</div>
      ${projects.length ? `<h2>Projects</h2>${itemsView(projects)}` : ''}
      ${pages.length ? `<h2>Pages</h2>${itemsView(pages)}` : ''}
      ${!projects.length && !pages.length ? '<p class="hint">Nothing matches. Try another word, or clear the search.</p>' : ''}`;
  } else if (hp) {
    const pages = [...hp.pages].reverse().map((pg) => ({ p: hp, pg }));
    html = `<div class="dash-head"><h1>${esc(hp.name)}${hp.site ? `<span class="site">${esc(hp.site)}</span>` : ''}</h1>${viewToggle()}
        <button class="btn light" data-project-menu="${esc(hp.slug)}">${ICONS.more}</button>
        <button class="btn primary" data-new-page="${esc(hp.slug)}">${ic('plus', 15)} New page</button></div>
      ${pages.length ? itemsView(pages) : `<div class="dash-empty small"><p>No pages yet. Ask your AI: “Create a landing page in Blobby project ${esc(hp.name)}”, or start a blank page.</p></div>`}`;
  } else if (!state.projects.length) {
    html = `<div class="dash-empty"><img src="mascot.svg" alt="">
      <h2>Design with your AI, in real HTML</h2>
      <p>Connect Blobby to Claude, ChatGPT, Cursor or any MCP app, then just ask for a design.<br>You'll watch it appear, comment on anything, and export clean HTML + CSS.</p>
      <div class="prompt" style="font-family:var(--mono);font-size:12.5px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px 14px;display:inline-block;margin:6px 0 18px">Create a landing page for acme.com in Blobby</div>
      <div class="row" style="display:flex;gap:8px;justify-content:center"><button class="btn primary" data-act="connect">${ic('plug', 15)} Connect AI</button><button class="btn light" data-act="new-project">New project</button></div></div>`;
  } else if (state.homeSection === 'projects') {
    html = `<div class="dash-head"><h1>Projects</h1>${viewToggle()}<button class="btn primary" data-act="new-project">${ic('plus', 15)} New project</button></div>
      ${itemsView(state.projects.map((p) => ({ p })))}`;
  } else {
    html = `<div class="dash-head"><h1>Recents</h1>${viewToggle()}<button class="btn primary" data-act="new-project">${ic('plus', 15)} New project</button></div>
      ${allPages.length ? itemsView(allPages.slice(0, 24)) : '<p class="hint">No pages yet. Open a project, or ask your AI to create a page.</p>'}`;
  }
  d.innerHTML = `<div class="dash-inner">${html}</div>`;
  d.querySelectorAll('img[data-thumb]').forEach((img) => {
    img.addEventListener('error', () => { img.replaceWith(Object.assign(document.createElement('img'), { className: 'ph', src: 'logo.svg', alt: '' })); }, { once: true });
  });
}

function projectMenu(slug, x, y) {
  const p = state.projects.find((x2) => x2.slug === slug);
  if (!p) return;
  showMenu(x, y, [
    { label: 'Open', icon: 'folder-open', action: () => goHome(slug) },
    { label: 'Rename…', icon: 'pencil', action: async () => {
      const v = await formModal({ title: 'Rename project', fields: [{ name: 'name', label: 'Name', value: p.name }, { name: 'site', label: 'Website', value: p.site }], okLabel: 'Save' });
      if (v?.name.trim()) { await run(() => store('renameProject', slug, { name: v.name.trim(), site: v.site.trim() })); await refreshProjects(); }
    } },
    { label: 'Duplicate', icon: 'copy', action: async () => { await run(() => store('duplicateProject', slug, {}), 'Project duplicated'); await refreshProjects(); } },
    { label: IS_MAC ? 'Show in Finder' : 'Show in folder', icon: 'folder', action: () => api.reveal(slug) },
    '-',
    { label: 'Delete…', icon: 'trash-2', danger: true, action: async () => {
      if (!(await confirmModal({ title: `Delete “${p.name}”?`, sub: `Its ${p.pages.length} page(s) and comments move to the trash folder.` }))) return;
      await run(() => store('deleteProject', slug), 'Project deleted');
      if (state.project === slug) { state.project = null; state.page = null; }
      state.homeProject = null;
      await refreshProjects();
      renderDash();
    } },
  ]);
}

function pageMenu(project, page, x, y) {
  const pg = state.projects.find((p) => p.slug === project)?.pages.find((x2) => x2.slug === page);
  if (!pg) return;
  showMenu(x, y, [
    { label: 'Open', icon: 'external-link', action: () => openProject(project, page) },
    { label: 'Rename…', icon: 'pencil', action: async () => {
      const v = await formModal({ title: 'Rename page', fields: [{ name: 'title', label: 'Name', value: pg.title }], okLabel: 'Save' });
      if (v?.title.trim()) { await run(() => store('renamePage', project, page, { title: v.title.trim() })); await refreshProjects(); }
    } },
    { label: 'Duplicate', icon: 'copy', action: async () => { await run(() => store('duplicatePage', project, page, {}), 'Page duplicated'); await refreshProjects(); } },
    { label: 'Export HTML + CSS', icon: 'download', action: () => doExport(project, page) },
    '-',
    { label: 'Delete…', icon: 'trash-2', danger: true, action: async () => {
      if (!(await confirmModal({ title: `Delete “${pg.title}”?`, sub: 'The page moves to the trash folder.' }))) return;
      await run(() => store('deletePage', project, page), 'Page deleted');
      await refreshProjects();
      if (state.project === project && state.page === page) {
        state.page = current()?.pages.at(-1)?.slug || null;
        if (state.view === 'editor') { renderBoards(); renderLayers(); renderPanel(); }
      }
    } },
  ]);
}

// ---------- canvas: artboards ----------

function renderBoards() {
  const world = $('#world');
  world.innerHTML = '';
  boards.clear();
  renderEmpty();
  if (!state.project || !state.page) return;
  let x = 0;
  for (const device of DEVICE_ORDER.filter((d) => state.devices.includes(d))) {
    const d = DEVICES[device];
    const el = document.createElement('div');
    el.className = 'artboard';
    el.style.left = `${x}px`;
    el.innerHTML = `<div class="artboard-label"><b>${d.label}</b><span>${d.width}px</span></div>
      <div class="frame-wrap" style="width:${d.width}px;height:${d.height}px"><div class="shield"></div></div>`;
    world.appendChild(el);
    const board = { device, el, wrap: $('.frame-wrap', el), shield: $('.shield', el), iframe: null };
    boards.set(device, board);
    bindShield(board);
    loadFrame(board);
    x += d.width + GAP;
  }
  fit();
}

const layerDevice = () => (boards.has(state.selDevice) ? state.selDevice : boards.keys().next().value);

// Loads (or reloads) a board. Reloads render offscreen first and swap in, so live edits don't flash.
function loadFrame(board) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('title', `${board.device} preview`);
  if (board.iframe) iframe.className = 'next';
  iframe.addEventListener('load', () => {
    const doc = iframe.contentDocument;
    if (!doc || !doc.body) return;
    if (iframe.classList.contains('next')) {
      board.iframe?.remove();
      iframe.classList.remove('next');
    }
    board.iframe = iframe;
    setupFrame(board);
  }, { once: true });
  iframe.src = api.fileUrl(state.project, `pages/${state.page}.html`, `vh=${DEVICES[board.device].height}&t=${Date.now()}`);
  board.wrap.insertBefore(iframe, board.shield);
}

function reloadFrames() { for (const board of boards.values()) loadFrame(board); }

function setupFrame(board) {
  const doc = board.iframe.contentDocument;
  const win = board.iframe.contentWindow;
  const resize = () => {
    board.wrap.style.height = `${Math.max(doc.documentElement.scrollHeight, 200)}px`;
    drawOverlays();
  };
  resize();
  new win.ResizeObserver(resize).observe(doc.documentElement);
  doc.fonts?.ready.then(resize);

  // Interact mode: keep links and forms inside the canvas.
  doc.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (a && !a.getAttribute('href').startsWith('#')) { e.preventDefault(); toast(`Link → ${a.getAttribute('href')}`); }
  }, true);
  doc.addEventListener('submit', (e) => { e.preventDefault(); toast('Form submitted (preview only)'); }, true);
  doc.addEventListener('wheel', (e) => {
    const r = board.iframe.getBoundingClientRect();
    onWheel({ preventDefault: () => e.preventDefault(), ctrlKey: e.ctrlKey, metaKey: e.metaKey, deltaX: e.deltaX, deltaY: e.deltaY,
      clientX: r.left + e.clientX * state.zoom, clientY: r.top + e.clientY * state.zoom });
  }, { passive: false });
  doc.addEventListener('keydown', (e) => { if (!state.editing) onKey(e); });

  if (board.device === layerDevice()) renderLayers();
  if (state.sel.length && !panelHasFocus()) renderPanel();
}

function docOf(device) { return boards.get(device)?.iframe?.contentDocument || null; }
function nodeIn(device, id) { return id ? docOf(device)?.querySelector(`[${ID}="${CSS.escape(id)}"]`) : null; }
function selectedEls(device = state.selDevice) { return state.sel.map((id) => nodeIn(device, id)).filter(Boolean); }
function selectedEl() { return nodeIn(state.selDevice, primary()); }

function localPoint(board, e) {
  const r = board.wrap.getBoundingClientRect();
  return { x: (e.clientX - r.left) / state.zoom, y: (e.clientY - r.top) / state.zoom };
}

function hitTest(board, e) {
  const doc = board.iframe?.contentDocument;
  if (!doc) return null;
  const pt = localPoint(board, e);
  let el = doc.elementFromPoint(pt.x, pt.y);
  while (el && !el.getAttribute?.(ID)) el = el.parentElement;
  return el;
}

function boxFor(el) {
  const r = el.getBoundingClientRect();
  const win = el.ownerDocument.defaultView;
  return { x: r.left + win.scrollX, y: r.top + win.scrollY, w: r.width, h: r.height };
}

function placeBox(div, b) {
  Object.assign(div.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
}

function overlay(board, cls, el, { tag = true, color } = {}) {
  const div = document.createElement('div');
  div.className = `hl ${cls}`;
  if (tag) div.innerHTML = `<span class="tag"${color ? ` style="background:${esc(color)}"` : ''}>${esc(typeof tag === 'string' ? tag : el.tagName.toLowerCase() + (el.classList[0] ? '.' + el.classList[0] : ''))}</span>`;
  if (color) div.style.borderColor = color;
  placeBox(div, boxFor(el));
  board.wrap.appendChild(div);
  return div;
}

let hoverState = null;
function drawOverlays() {
  for (const board of boards.values()) {
    board.wrap.querySelectorAll('.hl, .handle, .size-tag').forEach((n) => n.remove());
    if (hoverState && hoverState.device === board.device && !state.sel.includes(hoverState.nodeId)) {
      const el = nodeIn(board.device, hoverState.nodeId);
      if (el) overlay(board, 'hover', el);
    }
    if (state.editing) continue;
    const els = state.sel.map((id) => nodeIn(board.device, id)).filter(Boolean);
    els.forEach((el, i) => overlay(board, `sel${els.length > 1 ? ' multi' : ''}`, el, { tag: i === els.length - 1 }));
    if (els.length === 1 && board.device === state.selDevice && state.mode === 'select') drawHandles(board, els[0]);
  }
  drawPins();
}

function drawHandles(board, el) {
  const b = boxFor(el);
  for (const [h, x, y] of [['e', b.x + b.w, b.y + b.h / 2], ['s', b.x + b.w / 2, b.y + b.h], ['se', b.x + b.w, b.y + b.h]]) {
    const d = document.createElement('div');
    d.className = 'handle';
    d.dataset.h = h;
    d.style.left = `${x}px`;
    d.style.top = `${y}px`;
    d.addEventListener('mousedown', (e) => startResize(e, board, el, h));
    board.wrap.appendChild(d);
  }
}

function drawPins() {
  for (const board of boards.values()) board.wrap.querySelectorAll('.pin').forEach((n) => n.remove());
  if (!state.page) return;
  const open = state.feedback.filter((f) => f.status === 'open');
  open.forEach((f, i) => {
    if (f.page !== state.page) return;
    const device = boards.has(f.viewport) ? f.viewport : boards.keys().next().value;
    const board = boards.get(device);
    const el = nodeIn(device, f.nodeId);
    if (!board || !el) return;
    const b = boxFor(el);
    const pin = document.createElement('div');
    pin.className = 'pin';
    pin.textContent = String(i + 1);
    pin.title = f.comment;
    pin.style.left = `${b.x + b.w}px`;
    pin.style.top = `${b.y}px`;
    pin.addEventListener('mousedown', (e) => e.stopPropagation());
    pin.addEventListener('click', (e) => { e.stopPropagation(); state.activeThread = f.id; select([f.nodeId], device); setTab('feedback'); });
    board.wrap.appendChild(pin);
  });
}

// ---------- selection ----------

function select(ids, device, { additive = false } = {}) {
  ids = (ids || []).filter(Boolean);
  if (additive) {
    const set = [...state.sel];
    for (const id of ids) { const i = set.indexOf(id); if (i >= 0) set.splice(i, 1); else set.push(id); }
    state.sel = set;
  } else state.sel = ids;
  if (device) state.selDevice = device;
  hoverState = null;
  // Reveal the selection in the layers tree.
  const el = selectedEl();
  for (let p = el?.parentElement; p && p.tagName !== 'BODY'; p = p.parentElement) if (p.getAttribute(ID)) state.expanded.add(p.getAttribute(ID));
  drawOverlays();
  renderLayers();
  renderPanel();
  api.selectionChanged(state.sel.length ? {
    project: state.project, page: state.page, nodeId: primary(), nodeIds: state.sel, device: state.selDevice,
    label: describe(el), text: (el?.textContent || '').trim().slice(0, 300),
  } : null);
  setTimeout(() => $('.layer.sel')?.scrollIntoView({ block: 'nearest' }), 0);
}

function isTextOnly(el) {
  return [...el.querySelectorAll('*')].every((c) => TEXT_TAGS.has(c.tagName.toLowerCase())) && el.textContent.trim().length > 0;
}

function parentWithId(el) {
  let p = el?.parentElement;
  while (p && p.tagName !== 'BODY' && !p.getAttribute(ID)) p = p.parentElement;
  return p && p.tagName !== 'BODY' ? p : null;
}

const siblingsWithId = (el) => [...el.parentElement.children].filter((c) => c.getAttribute(ID));

function startTextEdit(board, el) {
  if (!isTextOnly(el)) return;
  const before = el.innerHTML;
  const id = el.getAttribute(ID);
  select([id], board.device);
  state.editing = { el, before };
  $('#app').classList.add('editing');
  drawOverlays();
  el.setAttribute('contenteditable', 'true');
  el.style.outline = '2px solid #e33f52';
  el.style.outlineOffset = '2px';
  el.focus();
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  const s = el.ownerDocument.getSelection();
  s.removeAllRanges();
  s.addRange(range);

  const finish = async (commit) => {
    el.removeEventListener('keydown', onKeyDown);
    el.removeEventListener('blur', onBlur);
    el.removeAttribute('contenteditable');
    el.style.outline = '';
    el.style.outlineOffset = '';
    if (!el.getAttribute('style')) el.removeAttribute('style');
    state.editing = null;
    $('#app').classList.remove('editing');
    const html = el.innerHTML;
    if (!commit) el.innerHTML = before;
    else if (html !== before) await run(() => store('writeHtml', state.project, state.page, { html, targetId: id, position: 'inner' }));
    drawOverlays();
  };
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.blur(); }
  };
  const onBlur = () => finish(true);
  el.addEventListener('keydown', onKeyDown);
  el.addEventListener('blur', onBlur);
}

// ---------- direct manipulation: move & resize ----------

const panMode = () => state.space || state.mode === 'hand';

function bindShield(board) {
  const s = board.shield;
  s.addEventListener('mousemove', (e) => {
    const pt = localPoint(board, e);
    if (panMode() || drag) return;
    const el = hitTest(board, e);
    const id = el?.getAttribute(ID) || null;
    if (hoverState?.nodeId === id && hoverState?.device === board.device) return;
    hoverState = id ? { nodeId: id, device: board.device } : null;
    drawOverlays();
    highlightLayer(id);
  });
  s.addEventListener('mouseleave', () => { hoverState = null; drawOverlays(); highlightLayer(null); });
  s.addEventListener('mousedown', (e) => {
    if (panMode() || e.button !== 0) return;
    e.stopPropagation();
    hideMenu();
    const el = hitTest(board, e);
    if (!el) { select([]); return; }
    const id = el.getAttribute(ID);
    if (state.commentArm) {
      state.commentArm = false;
      select([id], board.device);
      renderToolbar();
      openComposer();
      return;
    }
    if (e.shiftKey || e.metaKey) { select([id], board.device, { additive: true }); return; }
    if (!state.sel.includes(id) || board.device !== state.selDevice) select([id], board.device);
    startMove(e, board);
  });
  s.addEventListener('dblclick', (e) => {
    const el = hitTest(board, e);
    if (el) startTextEdit(board, el);
  });
  s.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const el = hitTest(board, e);
    if (el && !state.sel.includes(el.getAttribute(ID))) select([el.getAttribute(ID)], board.device);
    if (state.sel.length) elementMenu(e.clientX, e.clientY);
  });
}

let drag = null;

// Dragging selected elements reorders them in the layout (flow-aware). Absolutely positioned
// elements move freely instead.
function startMove(e, board) {
  const els = selectedEls(board.device);
  if (!els.length) return;
  const start = { x: e.clientX, y: e.clientY };
  const abs = els.length === 1 && ['absolute', 'fixed'].includes(getComputedStyle(els[0]).position);
  const origin = abs ? { left: parseFloat(getComputedStyle(els[0]).left) || 0, top: parseFloat(getComputedStyle(els[0]).top) || 0 } : null;
  let moved = false;
  let drop = null;
  const onMove = (ev) => {
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) { moved = true; drag = { board }; $('#app').classList.add('dragging'); }
    board.wrap.querySelectorAll('.drop-line, .ghost-box').forEach((n) => n.remove());
    if (abs) {
      els[0].style.left = `${Math.round(origin.left + dx / state.zoom)}px`;
      els[0].style.top = `${Math.round(origin.top + dy / state.zoom)}px`;
      drawOverlays();
      return;
    }
    els.forEach((el) => { const g = document.createElement('div'); g.className = 'ghost-box'; placeBox(g, boxFor(el)); board.wrap.appendChild(g); });
    drop = dropTarget(board, ev, els);
    if (drop) {
      const line = document.createElement('div');
      line.className = 'drop-line';
      const b = drop.box;
      const t = 3 / state.zoom;
      if (drop.horizontal) Object.assign(line.style, { left: `${(drop.position === 'before' ? b.x : b.x + b.w) - t / 2}px`, top: `${b.y}px`, width: `${t}px`, height: `${b.h}px` });
      else Object.assign(line.style, { left: `${b.x}px`, top: `${(drop.position === 'before' ? b.y : b.y + b.h) - t / 2}px`, width: `${b.w}px`, height: `${t}px` });
      board.wrap.appendChild(line);
    }
  };
  const onUp = async () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    board.wrap.querySelectorAll('.drop-line, .ghost-box').forEach((n) => n.remove());
    $('#app').classList.remove('dragging');
    drag = null;
    if (!moved) return;
    if (abs) {
      await run(() => store('updateStyles', state.project, state.page, { nodeIds: [state.sel[0]], styles: { left: els[0].style.left, top: els[0].style.top } }));
    } else if (drop) {
      await run(() => store('moveNodes', state.project, state.page, { nodeIds: orderedSelection(board.device), targetId: drop.id, position: drop.position }));
    }
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function orderedSelection(device) {
  const els = selectedEls(device);
  return els.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)).map((el) => el.getAttribute(ID));
}

function dropTarget(board, e, dragged) {
  let el = hitTest(board, e);
  while (el && dragged.some((d) => d === el || d.contains(el))) el = parentWithId(el);
  if (!el) return null;
  // Prefer a sibling of the dragged element when hovering inside one of its siblings.
  const parent = el.parentElement;
  const pcs = getComputedStyle(parent);
  const horizontal = (pcs.display.includes('flex') && !pcs.flexDirection.startsWith('column')) || (pcs.display.includes('grid') && pcs.gridTemplateColumns.split(' ').length > 1);
  const b = boxFor(el);
  const pt = localPoint(board, e);
  const position = horizontal ? (pt.x < b.x + b.w / 2 ? 'before' : 'after') : (pt.y < b.y + b.h / 2 ? 'before' : 'after');
  return { id: el.getAttribute(ID), position, horizontal, box: b };
}

function startResize(e, board, el, handle) {
  e.preventDefault();
  e.stopPropagation();
  const b = boxFor(el);
  const start = { x: e.clientX, y: e.clientY };
  const tag = document.createElement('div');
  tag.className = 'size-tag';
  board.wrap.appendChild(tag);
  let w = b.w;
  let h = b.h;
  const onMove = (ev) => {
    if (handle !== 's') { w = Math.max(1, Math.round(b.w + (ev.clientX - start.x) / state.zoom)); el.style.width = `${w}px`; }
    if (handle !== 'e') { h = Math.max(1, Math.round(b.h + (ev.clientY - start.y) / state.zoom)); el.style.height = `${h}px`; }
    const nb = boxFor(el);
    tag.textContent = `${Math.round(nb.w)} × ${Math.round(nb.h)}`;
    tag.style.left = `${nb.x + nb.w / 2}px`;
    tag.style.top = `${nb.y + nb.h + 8 / state.zoom}px`;
    board.wrap.querySelectorAll('.hl.sel').forEach((n) => placeBox(n, nb));
  };
  const onUp = async () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    tag.remove();
    const styles = {};
    if (handle !== 's') styles.width = `${w}px`;
    if (handle !== 'e') styles.height = `${h}px`;
    await run(() => store('updateStyles', state.project, state.page, { nodeIds: [el.getAttribute(ID)], styles }));
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ---------- element actions ----------

function cleanHtml(el) {
  const clone = el.cloneNode(true);
  [clone, ...clone.querySelectorAll(`[${ID}]`)].forEach((n) => n.removeAttribute(ID));
  return clone.outerHTML;
}

async function copySelection({ cut = false } = {}) {
  const ids = orderedSelection(state.selDevice);
  if (!ids.length) return;
  const html = ids.map((id) => cleanHtml(nodeIn(state.selDevice, id))).join('\n');
  state.clipboard = html;
  try { await navigator.clipboard.writeText(html); } catch { /* internal clipboard still works */ }
  if (cut) await deleteSelected();
  else toast(`Copied ${ids.length > 1 ? `${ids.length} elements` : 'element'}`);
}

async function paste() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { text = state.clipboard; }
  text = (text || state.clipboard || '').trim();
  if (!text || !state.page) return;
  const html = text.startsWith('<') ? text : `<p>${esc(text)}</p>`;
  const target = primary();
  const r = await run(() => store('writeHtml', state.project, state.page, target ? { html, targetId: target, position: 'after' } : { html }));
  if (r?.insertedIds?.length) setTimeout(() => select(r.insertedIds, state.selDevice), 350);
}

async function duplicateSelection() {
  const ids = orderedSelection(state.selDevice);
  if (!ids.length) return;
  const last = ids[ids.length - 1];
  const html = ids.map((id) => nodeIn(state.selDevice, id).outerHTML).join('');
  const r = await run(() => store('writeHtml', state.project, state.page, { html, targetId: last, position: 'after' }));
  if (r?.insertedIds?.length) setTimeout(() => select(r.insertedIds, state.selDevice), 350);
}

async function deleteSelected() {
  const ids = [...state.sel];
  if (!ids.length) return;
  select([]);
  await run(() => store('deleteNodes', state.project, state.page, { nodeIds: ids }), ids.length > 1 ? `Deleted ${ids.length} elements. ⌘Z to undo` : 'Deleted. ⌘Z to undo');
}

async function moveSibling(dir) {
  const el = selectedEl();
  if (!el) return;
  const sibs = siblingsWithId(el);
  const i = sibs.indexOf(el);
  const target = sibs[i + dir];
  if (!target) return;
  await run(() => store('moveNodes', state.project, state.page, { nodeIds: [primary()], targetId: target.getAttribute(ID), position: dir < 0 ? 'before' : 'after' }));
}

function elementMenu(x, y) {
  showMenu(x, y, [
    { label: 'Comment', icon: 'message-square-plus', k: 'C', action: () => openComposer() },
    '-',
    { label: 'Copy', icon: 'copy', k: '⌘C', action: () => copySelection() },
    { label: 'Cut', icon: 'scissors', k: '⌘X', action: () => copySelection({ cut: true }) },
    { label: 'Paste after', icon: 'clipboard-paste', k: '⌘V', action: () => paste() },
    { label: 'Duplicate', icon: 'copy', k: '⌘D', action: () => duplicateSelection() },
    '-',
    { label: 'Move up', icon: 'arrow-up', k: '⌥↑', action: () => moveSibling(-1) },
    { label: 'Move down', icon: 'arrow-down', k: '⌥↓', action: () => moveSibling(1) },
    { label: 'Select parent', icon: 'corner-left-up', k: '⇧↵', action: () => selectParent() },
    '-',
    { label: 'Delete', icon: 'trash-2', k: '⌫', danger: true, action: () => deleteSelected() },
  ]);
}

function selectParent() {
  const p = parentWithId(selectedEl());
  if (p) select([p.getAttribute(ID)], state.selDevice);
}

// ---------- layers ----------

function renderLayers() {
  const box = $('#layers');
  if (state.view !== 'editor') return;
  const doc = docOf(layerDevice());
  if (!state.page) { box.innerHTML = ''; return; }
  if (!doc) { box.innerHTML = '<div class="none">Loading…</div>'; return; }
  const rows = [];
  const walk = (el, depth) => {
    for (const child of el.children) {
      if (rows.length > 2500) return;
      if (['SCRIPT', 'STYLE'].includes(child.tagName) || !child.getAttribute(ID)) continue;
      const id = child.getAttribute(ID);
      const kids = [...child.children].some((c) => c.getAttribute(ID) && !['SCRIPT', 'STYLE'].includes(c.tagName)) && !isTextOnly(child);
      const open = state.expanded.has(id);
      const indent = 6 + depth * 14;
      rows.push(`<div class="layer${state.sel.includes(id) ? ' sel' : ''}" data-id="${id}" draggable="true" style="padding-left:${indent}px;--indent:${indent + 20}px" role="treeitem" aria-selected="${state.sel.includes(id)}">
        ${kids ? `<button class="caret${open ? ' open' : ''}" data-caret="${id}" tabindex="-1">${ICONS.caret}</button>` : '<span class="caret"></span>'}
        <span class="lico">${ICONS[kindOf(child)]}</span><span class="lname">${esc(layerName(child))}</span>
      </div>`);
      if (kids && open) walk(child, depth + 1);
    }
  };
  walk(doc.body, 0);
  box.innerHTML = rows.join('') || '<div class="none">Empty page. Ask your AI to add sections.</div>';
  $('#layersHint').textContent = boards.size > 1 ? DEVICES[layerDevice()].label : '';
}

function highlightLayer(id) {
  document.querySelectorAll('.layer.hover').forEach((n) => n.classList.remove('hover'));
  if (id) document.querySelector(`.layer[data-id="${CSS.escape(id)}"]`)?.classList.add('hover');
}

function bindLayers() {
  const box = $('#layers');
  let dragIds = null;
  box.addEventListener('mouseover', (e) => {
    const row = e.target.closest('.layer');
    const id = row?.dataset.id || null;
    if (hoverState?.nodeId === id) return;
    hoverState = id ? { nodeId: id, device: layerDevice() } : null;
    drawOverlays();
  });
  box.addEventListener('mouseleave', () => { hoverState = null; drawOverlays(); });
  box.addEventListener('click', (e) => {
    const caret = e.target.closest('[data-caret]');
    if (caret) {
      const id = caret.dataset.caret;
      if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
      renderLayers();
      return;
    }
    const row = e.target.closest('.layer');
    if (!row) return;
    select([row.dataset.id], layerDevice(), { additive: e.shiftKey || e.metaKey });
    const el = nodeIn(layerDevice(), row.dataset.id);
    if (el) {
      const r = el.getBoundingClientRect();
      const fr = boards.get(layerDevice()).wrap.getBoundingClientRect();
      const cr = $('#canvas').getBoundingClientRect();
      const top = fr.top + r.top * state.zoom;
      if (top < cr.top || top > cr.bottom - 40) reveal(layerDevice(), row.dataset.id);
    }
  });
  box.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.layer');
    if (!row) return;
    e.preventDefault();
    if (!state.sel.includes(row.dataset.id)) select([row.dataset.id], layerDevice());
    elementMenu(e.clientX, e.clientY);
  });
  box.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.layer');
    if (!row) return;
    dragIds = state.sel.includes(row.dataset.id) ? orderedSelection(layerDevice()) : [row.dataset.id];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragIds.join(','));
  });
  const clearDrop = () => box.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-inside'));
  const zone = (row, e) => {
    const r = row.getBoundingClientRect();
    const f = (e.clientY - r.top) / r.height;
    const el = nodeIn(layerDevice(), row.dataset.id);
    const canHold = el && !VOID_TAGS.has(el.tagName.toLowerCase()) && !isTextOnly(el);
    return f < 0.28 ? 'before' : f > 0.72 || !canHold ? 'after' : 'inside';
  };
  box.addEventListener('dragover', (e) => {
    const row = e.target.closest('.layer');
    if (!row || !dragIds) return;
    e.preventDefault();
    clearDrop();
    if (dragIds.includes(row.dataset.id)) return;
    row.classList.add(`drop-${zone(row, e)}`);
  });
  box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) clearDrop(); });
  box.addEventListener('drop', async (e) => {
    const row = e.target.closest('.layer');
    clearDrop();
    if (!row || !dragIds || dragIds.includes(row.dataset.id)) return;
    e.preventDefault();
    const z = zone(row, e);
    const ids = dragIds;
    dragIds = null;
    if (z === 'inside') state.expanded.add(row.dataset.id);
    await run(() => store('moveNodes', state.project, state.page, { nodeIds: ids, targetId: row.dataset.id, position: z === 'inside' ? 'append' : z }));
  });
  box.addEventListener('dragend', () => { dragIds = null; clearDrop(); });
}

// ---------- pan & zoom ----------

function applyTransform() {
  const w = $('#world');
  w.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  w.style.setProperty('--iz', String(1 / state.zoom));
  $('#zoomText').textContent = `${Math.round(state.zoom * 100)}%`;
}

function zoomAt(cx, cy, factor) {
  const r = $('#canvas').getBoundingClientRect();
  const z = Math.min(4, Math.max(0.05, state.zoom * factor));
  const px = cx - r.left;
  const py = cy - r.top;
  state.pan.x = px - ((px - state.pan.x) * z) / state.zoom;
  state.pan.y = py - ((py - state.pan.y) * z) / state.zoom;
  state.zoom = z;
  applyTransform();
}

function fit() {
  const r = $('#canvas').getBoundingClientRect();
  if (!r.width) return;
  const devices = DEVICE_ORDER.filter((d) => state.devices.includes(d));
  const total = devices.reduce((s, d) => s + DEVICES[d].width, 0) + GAP * (devices.length - 1);
  state.zoom = Math.min(1, (r.width - 120) / total);
  state.pan = { x: (r.width - total * state.zoom) / 2, y: 56 };
  applyTransform();
}

function onWheel(e) {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
  else {
    state.pan.x -= e.deltaX;
    state.pan.y -= e.deltaY;
    applyTransform();
  }
}

function bindCanvas() {
  const c = $('#canvas');
  c.addEventListener('wheel', onWheel, { passive: false });
  c.addEventListener('mousedown', (e) => {
    const onShield = e.target.classList.contains('shield');
    if (onShield && !panMode() && e.button !== 1) return;
    if (e.target.closest('.pin, .handle')) return;
    if (!onShield && e.button === 0 && !panMode()) select([]);
    const start = { x: e.clientX, y: e.clientY, px: state.pan.x, py: state.pan.y };
    c.classList.add('panning');
    const move = (ev) => {
      state.pan.x = start.px + ev.clientX - start.x;
      state.pan.y = start.py + ev.clientY - start.y;
      applyTransform();
    };
    const up = () => { c.classList.remove('panning'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  new ResizeObserver(() => applyTransform()).observe(c);
}

function reveal(device, nodeId) {
  const board = boards.get(device);
  const el = nodeIn(device, nodeId);
  if (!board || !el) return;
  const b = boxFor(el);
  const r = $('#canvas').getBoundingClientRect();
  const left = parseFloat(board.el.style.left);
  state.pan.x = r.width / 2 - (left + b.x + b.w / 2) * state.zoom;
  state.pan.y = r.height / 3 - (b.y + b.h / 2) * state.zoom;
  applyTransform();
}

// ---------- design panel ----------

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#panelInspect').hidden = tab !== 'inspect';
  $('#panelFeedback').hidden = tab !== 'feedback';
  renderPanel();
}

const panelHasFocus = () => !!document.activeElement?.closest?.('.panel') && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);

function renderPanel() {
  if (state.tab === 'feedback') renderFeedback();
  else renderInspect();
}

function renderInspect() {
  const box = $('#panelInspect');
  if (!state.project) { box.innerHTML = '<p class="hint">Pick or create a project to start.</p>'; return; }
  if (!state.page) { box.innerHTML = '<p class="hint">This project has no pages yet. Ask your AI to create one, or press + next to Pages.</p>'; return; }
  const el = selectedEl();
  if (!el) return renderPageInfo(box);

  const cs = el.ownerDocument.defaultView.getComputedStyle(el);
  const inl = (p) => el.style.getPropertyValue(p);
  // Computed sizes come back like 607.188px; show whole pixels unless the value was set by hand.
  const val = (p) => inl(p) || cs.getPropertyValue(p).replace(/(-?\d+\.\d+)px/g, (_, n) => `${Math.round(Number(n))}px`);
  const isSet = (p) => (inl(p) ? ' set' : '');
  const tag = el.tagName.toLowerCase();
  const n = state.sel.length;
  const ancestors = [];
  for (let p = el.parentElement; p && p.tagName !== 'BODY'; p = p.parentElement) if (p.getAttribute(ID)) ancestors.unshift(p);

  const num = (prop, lab, title = prop) => `<label class="num" title="${esc(title)}"><span class="lab">${esc(lab)}</span><input class="input${isSet(prop)}" data-prop="${prop}" value="${esc(val(prop))}"></label>`;
  const color = (prop) => {
    const hex = rgbToHex(val(prop));
    return `<div class="color-in"><input type="color" data-prop="${prop}" value="${hex === 'transparent' ? '#ffffff' : hex}"><input class="input mono${isSet(prop)}" data-prop="${prop}" value="${esc(hex === 'transparent' ? 'transparent' : hex)}"></div>`;
  };
  const chips = (prop, opts) => `<div class="chips">${opts.map(([v, label, title]) => `<button data-set-prop="${prop}" data-value="${esc(v)}" title="${esc(title || v)}" class="${val(prop) === v ? 'on' : ''}">${label}</button>`).join('')}</div>`;
  const select = (prop, opts) => {
    const v = val(prop);
    const list = opts.includes(v) ? opts : [v, ...opts];
    return `<select class="input${isSet(prop)}" data-prop="${prop}">${list.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  };

  const display = val('display');
  const isFlex = display.includes('flex');
  const isGrid = display.includes('grid');
  const row = !val('flex-direction').startsWith('column');
  const jc = val('justify-content');
  const ai = val('align-items');
  const pos3 = (v) => (/(end|right|bottom)$/.test(v) ? 2 : /center/.test(v) ? 1 : 0);
  const alignGrid = isFlex ? (() => {
    const x = row ? pos3(jc) : pos3(ai);
    const y = row ? pos3(ai) : pos3(jc);
    let cells = '';
    for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < 3; xx++) cells += `<button data-align="${xx},${yy}" class="${xx === x && yy === y && jc !== 'space-between' ? 'on' : ''}" title="Align"></button>`;
    return `<div class="align-grid">${cells}</div>`;
  })() : '';

  const families = [...new Set([...Object.entries(current()?.tokens?.vars || {}).filter(([k]) => k.startsWith('--font')).map(([k]) => `var(${k})`), 'inherit', 'system-ui, sans-serif', 'Georgia, serif', 'ui-monospace, monospace'])];
  const attrs = [];
  if (tag === 'a') attrs.push(['href', 'Link']);
  if (tag === 'img') attrs.push(['src', 'Image'], ['alt', 'Alt text']);
  if (['input', 'textarea'].includes(tag)) attrs.push(['placeholder', 'Placeholder']);
  attrs.push(['class', 'Classes']);

  box.innerHTML = `
    ${n > 1 ? `<div class="multi-note"><b>${n} elements selected.</b> Style changes apply to all of them.</div>` : ''}
    <div class="el-head"><span class="el-tag">${esc(tag)}</span><span class="el-cls">${esc(layerName(el))}</span></div>
    ${ancestors.length ? `<div class="crumb-path">${ancestors.slice(-4).map((a) => `<button data-sel="${a.getAttribute(ID)}">${esc(a.tagName.toLowerCase())}${a.classList[0] ? '.' + esc(a.classList[0]) : ''}</button><span>›</span>`).join('')}<span>${esc(tag)}</span></div>` : ''}
    <div class="actions">
      <button class="btn primary small" data-act="comment" title="Comment (C)">${ic('message-square-plus', 14)} Comment</button>
      <span class="icon-row">
        ${ancestors.length ? `<button class="ibtn" data-act="parent" title="Select parent (⇧↵)" aria-label="Select parent">${ic('corner-left-up', 15)}</button>` : ''}
        <button class="ibtn" data-act="up" title="Move up (⌥↑)" aria-label="Move up">${ic('arrow-up', 15)}</button><button class="ibtn" data-act="down" title="Move down (⌥↓)" aria-label="Move down">${ic('arrow-down', 15)}</button>
        <button class="ibtn" data-act="duplicate" title="Duplicate (⌘D)" aria-label="Duplicate">${ic('copy', 15)}</button><button class="ibtn" data-act="copy" title="Copy HTML (⌘C)" aria-label="Copy HTML">${ic('code', 15)}</button>
        <button class="ibtn danger" data-act="delete" title="Delete (⌫)" aria-label="Delete">${ic('trash-2', 15)}</button>
      </span>
    </div>
    ${n === 1 && isTextOnly(el) ? `<div class="sec"><div class="sec-head">Text</div><textarea data-text>${esc(el.textContent.trim())}</textarea></div>` : ''}
    ${n === 1 ? `<div class="sec"><div class="sec-head">Content</div>${attrs.map(([a, l]) => `<div class="field"><label>${l}</label><input class="input mono" data-attr="${a}" value="${esc(el.getAttribute(a) || '')}"></div>`).join('')}
      ${tag === 'img' ? '<div class="actions" style="margin-top:4px"><button class="btn light small" data-act="pick-image">Choose image…</button></div>' : ''}</div>` : ''}
    <div class="sec"><div class="sec-head">Layout</div>
      ${chips('display', [['block', 'Block'], ['flex', 'Flex'], ['grid', 'Grid'], ['inline-block', 'Inline'], ['none', 'Hide']])}
      ${isFlex ? `<div class="flexbox">${alignGrid}<div class="grow">
          ${chips('flex-direction', [['row', '→ Row'], ['column', '↓ Col']])}
          ${chips('flex-wrap', [['nowrap', 'No wrap'], ['wrap', 'Wrap']])}
          <div class="row2">${num('gap', 'G', 'gap')}<button class="ibtn${jc === 'space-between' ? ' on' : ''}" data-set-prop="justify-content" data-value="space-between" title="Space between">↔ Between</button></div>
        </div></div>` : ''}
      ${isGrid ? `<div class="field"><label>Columns</label><input class="input mono${isSet('grid-template-columns')}" data-prop="grid-template-columns" value="${esc(val('grid-template-columns'))}"></div><div class="row2">${num('gap', 'G', 'gap')}</div>` : ''}
    </div>
    <div class="sec"><div class="sec-head">Size</div>
      <div class="row2">${num('width', 'W')}${num('height', 'H')}</div>
      <div class="row2">${num('min-width', '↥', 'min-width')}${num('max-width', '↧', 'max-width')}</div>
      <div class="chips"><button data-set-prop="width" data-value="100%" title="Fill the parent">Fill width</button><button data-set-prop="width" data-value="fit-content" title="Hug the content">Hug</button><button data-set-prop="width" data-value="" title="Remove the width override">Auto</button></div>
    </div>
    <div class="sec"><div class="sec-head">Spacing</div>
      <div class="hint" style="margin-bottom:4px">Padding</div>
      <div class="row4">${num('padding-top', 'T')}${num('padding-right', 'R')}${num('padding-bottom', 'B')}${num('padding-left', 'L')}</div>
      <div class="hint" style="margin-bottom:4px">Margin</div>
      <div class="row4">${num('margin-top', 'T')}${num('margin-right', 'R')}${num('margin-bottom', 'B')}${num('margin-left', 'L')}</div>
    </div>
    <div class="sec"><div class="sec-head">Typography</div>
      <div class="field"><label>Font</label>${select('font-family', families)}</div>
      <div class="row2">${num('font-size', 'Sz', 'font-size')}<label class="num"><span class="lab">Wt</span>${select('font-weight', ['300', '400', '500', '600', '700', '800', '900']).replace('class="input', 'class="input" style="padding-left:24px" data-x="')}</label></div>
      <div class="row2">${num('line-height', 'LH', 'line-height')}${num('letter-spacing', 'LS', 'letter-spacing')}</div>
      <div class="field"><label>Color</label>${color('color')}</div>
      ${chips('text-align', [['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['justify', 'Justify']])}
    </div>
    <div class="sec"><div class="sec-head">Fill</div>
      <div class="field"><label>Background</label>${color('background-color')}</div>
      <div class="field"><label>Image / gradient</label><input class="input mono${isSet('background-image')}" data-prop="background-image" value="${esc(val('background-image'))}"></div>
    </div>
    <div class="sec"><div class="sec-head">Border</div>
      <div class="row2">${num('border-radius', 'R', 'border-radius')}${num('border-width', 'W', 'border-width')}</div>
      <div class="row2">${select('border-style', ['none', 'solid', 'dashed', 'dotted'])}<div>${color('border-color')}</div></div>
    </div>
    <div class="sec"><div class="sec-head">Effects</div>
      <div class="row2">${num('opacity', 'Op', 'opacity')}${num('z-index', 'Z', 'z-index')}</div>
      <div class="field"><label>Shadow</label><input class="input mono${isSet('box-shadow')}" data-prop="box-shadow" value="${esc(val('box-shadow'))}"></div>
      <div class="chips"><button data-set-prop="box-shadow" data-value="none">None</button><button data-set-prop="box-shadow" data-value="0 1px 3px rgba(0,0,0,.12)">S</button><button data-set-prop="box-shadow" data-value="0 8px 24px rgba(0,0,0,.12)">M</button><button data-set-prop="box-shadow" data-value="0 24px 60px rgba(0,0,0,.18)">L</button></div>
    </div>
    <div class="sec"><div class="sec-head">Position</div>
      <div class="field"><label>Mode</label>${select('position', ['static', 'relative', 'absolute', 'fixed', 'sticky'])}</div>
      ${val('position') !== 'static' ? `<div class="row4">${num('top', 'T')}${num('right', 'R')}${num('bottom', 'B')}${num('left', 'L')}</div>` : ''}
    </div>
    <p class="hint" style="margin-top:10px">Bold values are set on this element. Use ↑ ↓ in number fields (⇧ for ×10). For bigger changes, leave a comment for your AI.</p>`;
}

async function renderPageInfo(box) {
  const p = current();
  const pg = currentPage();
  const vars = Object.entries(p.tokens?.vars || {});
  const isColor = (v) => /^#|^rgb|^hsl/.test(v.trim());
  const brief = await store('getBrief', state.project, state.page).catch(() => null);
  if (selectedEl() || state.tab !== 'inspect') return;
  box.innerHTML = `
    <div class="sec"><div class="sec-head">Page</div>
      <div class="field"><label>Name</label><input class="input" data-page-title value="${esc(pg?.title)}"></div>
      <p class="hint" style="margin:6px 0 0">Click to select, drag to reorder, double-click text to edit. <kbd>P</kbd> to try hovers and links. <kbd>C</kbd> to comment.</p>
    </div>
    <div class="sec"><div class="sec-head">Artboards</div><div class="chips dev-chips" data-devices></div></div>
    <div class="sec"><div class="sec-head">MCP</div>
      <button class="btn light wide-btn" data-act="connect">${ic('plug', 14)} Connect more agents</button>
    </div>
    ${brief ? `<div class="sec"><div class="sec-head">Brief</div>
      <p style="margin:0 0 6px"><b>Goal:</b> ${esc(brief.goal)}</p>
      ${brief.sections?.length ? `<p style="margin:0 0 4px;color:var(--muted)">Sections</p><ol style="margin:0 0 6px;padding-left:18px">${brief.sections.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
      ${brief.must_haves?.length ? `<p style="margin:0 0 4px;color:var(--muted)">Must-haves</p><ul style="margin:0;padding-left:18px">${brief.must_haves.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
    </div>` : ''}
    <div class="sec"><div class="sec-head">Brand tokens</div>
      <div class="swatches">
      ${vars.map(([k, v]) => `<div class="field"><label class="mono" title="${esc(k)}">${esc(k.replace(/^--/, ''))}</label>
        ${isColor(v) ? `<div class="color-in"><input type="color" data-token="${esc(k)}" value="${rgbToHex(v) === 'transparent' ? '#ffffff' : rgbToHex(v)}"><input class="input mono" data-token="${esc(k)}" value="${esc(v)}"></div>`
          : `<input class="input mono" data-token="${esc(k)}" value="${esc(v)}">`}</div>`).join('')}
      </div>
      <p class="hint">Shared by every page in this project. Ask your AI to “match the brand of acme.com”, or edit here.</p>
    </div>
    <div class="sec"><div class="sec-head">Assets</div><div class="actions" style="margin-top:0"><button class="btn light small" data-act="add-asset">Add image…</button></div></div>`;
  renderToolbar();
}

// Live preview in every artboard while editing; the file is written once input settles.
const pendingStyles = {};
let styleTimer = null;
function applyStyle(prop, value, { now = false } = {}) {
  for (const board of boards.values()) {
    for (const id of state.sel) {
      const el = nodeIn(board.device, id);
      if (el) { if (value === '' || value == null) el.style.removeProperty(prop); else el.style.setProperty(prop, value); }
    }
  }
  drawOverlays();
  pendingStyles[prop] = value === '' ? null : value;
  clearTimeout(styleTimer);
  const flush = async () => {
    const styles = { ...pendingStyles };
    for (const k of Object.keys(pendingStyles)) delete pendingStyles[k];
    await run(() => store('updateStyles', state.project, state.page, { nodeIds: [...state.sel], styles }));
  };
  if (now) flush(); else styleTimer = setTimeout(flush, 350);
}

function stepValue(v, delta) {
  const m = String(v).trim().match(/^(-?\d*\.?\d+)([a-z%]*)$/i);
  if (!m) return null;
  const decimals = (m[1].split('.')[1] || '').length;
  const unit = m[2] || (Math.abs(Number(m[1])) < 4 && decimals ? '' : 'px');
  const step = unit === '' && decimals ? 0.1 : 1;
  return `${(Number(m[1]) + delta * step).toFixed(unit === '' && decimals ? Math.max(decimals, 1) : 0)}${unit}`;
}

function bindPanel() {
  const ins = $('#panelInspect');
  ins.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.token) {
      await run(() => store('setTokens', state.project, { vars: { [t.dataset.token]: t.value } }));
      await refreshProjects();
      return;
    }
    if (t.hasAttribute('data-page-title')) {
      if (t.value.trim()) { await run(() => store('renamePage', state.project, state.page, { title: t.value.trim() })); await refreshProjects(); }
      return;
    }
    if (!state.sel.length) return;
    const id = primary();
    if (t.dataset.prop) applyStyle(t.dataset.prop, t.value.trim(), { now: true });
    else if (t.dataset.attr) await run(() => store('setAttributes', state.project, state.page, { nodeId: id, attributes: { [t.dataset.attr]: t.value } }));
    else if (t.hasAttribute('data-text')) await run(() => store('setText', state.project, state.page, { nodeId: id, text: t.value }));
  });
  ins.addEventListener('input', (e) => {
    const t = e.target;
    if (t.type === 'color' && t.dataset.prop) applyStyle(t.dataset.prop, t.value);
  });
  ins.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.tagName === 'INPUT' && t.dataset.prop && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const next = stepValue(t.value, (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
      if (next !== null) { e.preventDefault(); t.value = next; applyStyle(t.dataset.prop, next); }
    }
    if (t.tagName === 'INPUT' && e.key === 'Enter') t.blur();
  });
  ins.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sel],[data-act],[data-set-prop],[data-align],[data-device]');
    if (!b) return;
    if (b.dataset.device) return toggleDevice(b.dataset.device);
    if (b.dataset.act === 'connect') return connectModal();
    if (b.dataset.sel) return select([b.dataset.sel], state.selDevice);
    if (b.dataset.setProp) { applyStyle(b.dataset.setProp, b.dataset.value, { now: true }); setTimeout(renderInspect, 50); return; }
    if (b.dataset.align) {
      const [x, y] = b.dataset.align.split(',').map(Number);
      const v = ['flex-start', 'center', 'flex-end'];
      const el = selectedEl();
      const row = !getComputedStyle(el).flexDirection.startsWith('column');
      applyStyle('justify-content', v[row ? x : y]);
      applyStyle('align-items', v[row ? y : x], { now: true });
      setTimeout(renderInspect, 50);
      return;
    }
    const el = selectedEl();
    switch (b.dataset.act) {
      case 'comment': openComposer(); break;
      case 'parent': selectParent(); break;
      case 'up': moveSibling(-1); break;
      case 'down': moveSibling(1); break;
      case 'duplicate': duplicateSelection(); break;
      case 'copy': copySelection(); break;
      case 'delete': deleteSelected(); break;
      case 'pick-image': {
        const a = await run(() => api.addAsset(state.project));
        if (a) await run(() => store('setAttributes', state.project, state.page, { nodeId: el.getAttribute(ID), attributes: { src: a.path } }));
        break;
      }
      case 'add-asset': {
        const a = await run(() => api.addAsset(state.project));
        if (a) { await navigator.clipboard.writeText(a.path).catch(() => {}); toast(`Added. Path copied: ${a.path}`); }
        break;
      }
    }
  });

  bindComments();
}

// ---------- comments ----------

function openComposer() {
  if (!state.sel.length) { toast('Select an element to comment on'); return; }
  setTab('feedback');
  setTimeout(() => $('#fbText')?.focus(), 0);
}

function renderFeedback() {
  const box = $('#panelFeedback');
  if (!state.project) { box.innerHTML = '<p class="hint">Pick a project first.</p>'; return; }
  const el = selectedEl();
  const draft = $('#fbText')?.value || '';
  const open = state.feedback.filter((f) => f.status === 'open');
  const resolved = state.feedback.filter((f) => f.status !== 'open').reverse();
  const pageTitle = (slug) => current()?.pages.find((p) => p.slug === slug)?.title || slug;
  const name = (u) => u?.name || 'You';
  const thread = (f, i) => `<div class="thread ${f.status}${state.activeThread === f.id ? ' active' : ''}" data-thread="${f.id}">
      <div class="thread-head" data-goto="${f.id}"><span class="num">${f.status === 'open' ? i + 1 : '✓'}</span>
        <div class="msg-first"><div class="who">${avatar(f.author)}<b>${esc(name(f.author))}</b><span>${timeAgo(f.createdAt)}</span></div><div class="body">${esc(f.comment)}</div></div></div>
      <div class="el">${esc(f.label || f.nodeId)}${f.viewport ? ` · ${esc(DEVICES[f.viewport]?.label || f.viewport)}` : ''}${f.page !== state.page ? ` · ${esc(pageTitle(f.page))}` : ''}</div>
      ${(f.replies || []).map((r) => `<div class="msg${r.ai ? ' ai' : ''}"><div class="who">${r.ai ? '<span class="av ai">AI</span><b>AI</b>' : `${avatar(r.author)}<b>${esc(name(r.author))}</b>`}<span>${timeAgo(r.createdAt)}</span></div><div class="body">${esc(r.text)}</div></div>`).join('')}
      ${!f.replies?.length && f.reply ? `<div class="msg ai"><div class="who"><span class="av ai">AI</span><b>AI</b></div><div class="body">${esc(f.reply)}</div></div>` : ''}
      <div class="thread-foot"><input data-reply="${f.id}" placeholder="Reply…">
        <button class="ibtn" data-status="${f.id}" title="${f.status === 'open' ? 'Resolve' : 'Reopen'}" aria-label="${f.status === 'open' ? 'Resolve' : 'Reopen'}">${ic(f.status === 'open' ? 'check' : 'rotate-ccw', 15)}</button>
        <button class="ibtn danger" data-del="${f.id}" title="Delete thread" aria-label="Delete thread">${ic('trash-2', 15)}</button></div>
    </div>`;
  box.innerHTML = `
    ${el ? `<div class="composer">
      <div class="target">On <b>${esc(describe(el))}</b>${state.sel.length > 1 ? ` (+${state.sel.length - 1})` : ''} · ${esc(DEVICES[state.selDevice].label)}</div>
      <textarea id="fbText" placeholder="What should change? e.g. Make this headline shorter and make the button stand out more">${esc(draft)}</textarea>
      <div class="row"><span class="hint"><kbd>⌘</kbd><kbd>↵</kbd></span><button class="btn primary small" data-send>Comment</button></div>
    </div>` : '<p class="hint" style="margin-top:0">Select an element and press <kbd>C</kbd> to comment on it.</p>'}
    <h3>Open (${open.length})</h3>
    ${open.length ? open.map(thread).join('') : '<p class="hint">No open comments.</p>'}
    ${resolved.length ? `<h3><button class="link" data-toggle-resolved style="color:inherit;font:inherit;text-transform:inherit;letter-spacing:inherit">${state.showResolved ? '▾' : '▸'} Resolved (${resolved.length})</button></h3>
      ${state.showResolved ? resolved.map(thread).join('') : ''}` : ''}
    <div class="howto">Your AI sees every open comment. Tell it: <b>“Apply my Blobby feedback”</b>. It makes the changes, runs QA and replies here. <button class="link" data-copy-prompt style="color:var(--fg);text-decoration:underline">Copy</button></div>`;
}

function bindComments() {
  const fb = $('#panelFeedback');
  fb.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-send]')) return sendFeedback();
    if (t.closest('[data-copy-prompt]')) { await navigator.clipboard.writeText('Apply my Blobby feedback'); return toast('Copied. Paste it in your AI'); }
    if (t.closest('[data-toggle-resolved]')) { state.showResolved = !state.showResolved; return renderFeedback(); }
    const del = t.closest('[data-del]');
    if (del) {
      if (await confirmModal({ title: 'Delete this comment thread?' })) await run(() => store('deleteFeedback', state.project, del.dataset.del));
      return;
    }
    const st = t.closest('[data-status]');
    if (st) {
      const f = state.feedback.find((x) => x.id === st.dataset.status);
      await run(() => store('updateFeedback', state.project, f.id, { status: f.status === 'open' ? 'resolved' : 'open' }));
      return;
    }
    const go = t.closest('[data-goto]');
    if (go) {
      const f = state.feedback.find((x) => x.id === go.dataset.goto);
      if (!f) return;
      state.activeThread = f.id;
      if (f.page !== state.page) await openProject(state.project, f.page);
      const device = boards.has(f.viewport) ? f.viewport : boards.keys().next().value;
      const jump = () => { select([f.nodeId], device); reveal(device, f.nodeId); };
      if (nodeIn(device, f.nodeId)) jump(); else setTimeout(jump, 600);
    }
  });
  fb.addEventListener('keydown', async (e) => {
    if (e.target.id === 'fbText' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendFeedback(); }
    if (e.target.dataset.reply && e.key === 'Enter' && e.target.value.trim()) {
      e.preventDefault();
      const text = e.target.value.trim();
      const id = e.target.dataset.reply;
      e.target.value = '';
      e.target.blur();
      state.activeThread = id;
      await run(() => store('addReply', state.project, id, { text }));
      await loadFeedback();
      renderFeedback();
    }
  });
}

async function sendFeedback() {
  const el = selectedEl();
  const text = $('#fbText')?.value.trim();
  if (!el || !text) return;
  const board = boards.get(state.selDevice);
  const b = boxFor(el);
  let screenshot = null;
  if (api.captureRect) {
    const wr = board.wrap.getBoundingClientRect();
    const cr = $('#canvas').getBoundingClientRect();
    const pad = 12;
    const x1 = Math.max(cr.left, wr.left + (b.x - pad) * state.zoom);
    const y1 = Math.max(cr.top, wr.top + (b.y - pad) * state.zoom);
    const x2 = Math.min(cr.right, wr.left + (b.x + b.w + pad) * state.zoom);
    const y2 = Math.min(cr.bottom, wr.top + (b.y + b.h + pad) * state.zoom);
    hoverState = null;
    drawOverlays();
    if (x2 > x1 && y2 > y1) screenshot = await api.captureRect({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
  }
  const extra = state.sel.length > 1 ? `\n(Also applies to: ${state.sel.slice(0, -1).map((id) => describe(nodeIn(state.selDevice, id))).join('; ')})` : '';
  const r = await run(() => store('addFeedback', state.project, {
    page: state.page, nodeId: primary(), comment: text + extra, label: describe(el),
    snippet: cleanHtml(el), viewport: state.selDevice, screenshot,
  }));
  if (r) {
    $('#fbText').value = '';
    $('#fbText').blur();
    state.activeThread = r.id;
    await loadFeedback();
    renderFeedback();
    toast('Comment added. Tell your AI: “Apply my Blobby feedback”', { ms: 3500 });
  }
}

// ---------- connect AI ----------

const AGENTS = [
  { id: 'claude', name: 'Claude', brand: 'claude' },
  { id: 'chatgpt', name: 'ChatGPT', icon: 'bot' },
  { id: 'codex', name: 'Codex', icon: 'terminal' },
  { id: 'claudecode', name: 'Claude Code', brand: 'claudecode' },
  { id: 'cursor', name: 'Cursor', brand: 'cursor' },
  { id: 'windsurf', name: 'Windsurf', brand: 'windsurf' },
  { id: 'vscode', name: 'VS Code', icon: 'code' },
  { id: 'copilot', name: 'GitHub Copilot', brand: 'copilot' },
  { id: 'gemini', name: 'Gemini CLI', brand: 'gemini' },
  { id: 'other', name: 'Other agents', icon: 'ellipsis' },
];

const FIRST_PROMPTS = ['Create a landing page for acme.com in Blobby', 'List my Blobby projects', 'Apply my Blobby feedback'];

const tomlValue = (v) => (Array.isArray(v) ? `[${v.map(tomlValue).join(', ')}]` : typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `${k} = ${tomlValue(x)}`).join(', ')} }` : JSON.stringify(String(v)));

// What step 2 shows for each agent: an optional one-click action, a short note, and manual config.
function agentSetup(id, s) {
  const url = s.httpUrl;
  const launch = s.json ? JSON.parse(s.json).mcpServers.blobby : null; // desktop stdio launcher
  const httpOrLaunch = url ? { url } : launch;
  const vsCfg = url ? { type: 'http', url } : { type: 'stdio', ...launch };
  const json = (o) => JSON.stringify(o, null, 2);
  const copyUrl = { label: 'Copy URL', act: 'copy-url' };
  switch (id) {
    case 'claude': return { title: 'Add Blobby to Claude Desktop', sub: s.desktop ? 'Connected. Restart Claude if Blobby doesn’t show up.' : 'Writes Blobby into Claude’s config (a backup is kept). Restart Claude afterwards.',
        connected: s.desktop, button: { label: s.desktop ? 'Reconnect' : 'Add to Claude', act: 'desktop', brand: 'claude', primary: !s.desktop },
        manual: [['claude_desktop_config.json', s.json]] };
    case 'claudecode': {
      const cmd = s.codeCommand;
      return { title: 'Register Blobby with Claude Code', sub: s.code ? 'Connected for your user. Restart any running Claude Code sessions.' : 'Runs claude mcp add for your user.',
          connected: s.code, button: { label: s.code ? 'Reconnect' : 'Add to Claude Code', act: 'code', brand: 'claudecode', primary: !s.code }, manual: [['Terminal', cmd]] };
    }
    case 'chatgpt': return { title: 'ChatGPT needs a public URL', sub: 'ChatGPT only connects to servers on the internet, so it can’t reach this computer directly. Codex (OpenAI’s coding agent) works locally today. Advanced: expose the local URL with a tunnel such as cloudflared, then add it in ChatGPT → Settings → Apps & Connectors → Developer mode. Anyone with that URL can edit your designs, so keep it private.', button: url ? copyUrl : null };
    case 'codex': {
      const toml = `[mcp_servers.blobby]\n${Object.entries(httpOrLaunch).map(([k, v]) => `${k} = ${tomlValue(v)}`).join('\n')}`;
      return { title: 'Add Blobby to Codex', sub: 'Paste into ~/.codex/config.toml. Works in the Codex CLI, IDE extension and app.', button: { label: 'Copy config', act: 'copy', text: toml }, manual: [['~/.codex/config.toml', toml]] };
    }
    case 'cursor': {
      const link = `cursor://anysphere.cursor-deeplink/mcp/install?name=blobby&config=${encodeURIComponent(btoa(JSON.stringify(httpOrLaunch)))}`;
      return { title: 'Add through a Cursor install link', sub: 'Opens Cursor and asks you to confirm.', button: { label: 'Add to Cursor', act: 'open', href: link, brand: 'cursor' }, manual: [['~/.cursor/mcp.json', json({ mcpServers: { blobby: httpOrLaunch } })]] };
    }
    case 'windsurf': {
      const cfg = json({ mcpServers: { blobby: url ? { serverUrl: url } : launch } });
      return { title: 'Add to Windsurf', sub: 'Cascade → MCP servers → Manage → View raw config, then add this.', button: { label: 'Copy JSON', act: 'copy', text: cfg }, manual: [['~/.codeium/windsurf/mcp_config.json', cfg]] };
    }
    case 'vscode':
    case 'copilot': {
      const link = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'blobby', ...vsCfg }))}`;
      return { title: id === 'copilot' ? 'Add to VS Code for Copilot agent mode' : 'Install in VS Code',
        sub: id === 'copilot' ? 'GitHub Copilot uses the MCP servers in VS Code. Switch Copilot Chat to Agent mode after installing.' : 'Opens VS Code and asks you to confirm.',
        button: { label: 'Add to VS Code', act: 'open', href: link, icon: 'code' }, manual: [['.vscode/mcp.json', json({ servers: { blobby: vsCfg } })]] };
    }
    case 'gemini': {
      const cfg = json({ mcpServers: { blobby: url ? { httpUrl: url } : launch } });
      return { title: 'Add to Gemini CLI', sub: 'Merge this into ~/.gemini/settings.json, then run gemini.', button: { label: 'Copy JSON', act: 'copy', text: cfg }, manual: [['~/.gemini/settings.json', cfg]] };
    }
    default: return { title: 'Any app that supports MCP', sub: url ? 'Use the URL as a Streamable HTTP server with no authentication.' : 'Use the command below as a stdio server.',
      button: url ? copyUrl : null, manual: [...(url ? [['Server URL (Streamable HTTP)', url]] : []), ...(launch ? [['stdio (launches Blobby)', json({ mcpServers: { blobby: launch } })]] : [])] };
  }
}

async function connectModal(agentId = saved('agent', 'claude')) {
  const s = await run(() => api.claudeStatus());
  if (!s) return;
  let active = AGENTS.some((a) => a.id === agentId) ? agentId : 'claude';
  const copy = async (text, msg = 'Copied') => { await navigator.clipboard.writeText(text); toast(msg); };
  const logo = (a, size = 18) => (a.brand ? brandIcon(a.brand, size) : ic(a.icon, size));
  const url = s.httpUrl;
  const m = modal('');
  m.classList.add('connect');
  let snippets = [];

  const step1 = () => `<div class="step done"><span class="n">${ic('check', 13)}</span><div><h4>Blobby is running</h4>
      <div class="trust">${ic('shield-check', 16)}<span>Runs on this computer only. Designs stay in <b>${esc(state.appInfo?.root || '~/Blobby')}</b>, and the local server only accepts connections from this computer.</span></div></div></div>`;

  const render = () => {
    const a = AGENTS.find((x) => x.id === active);
    const st = agentSetup(active, s);
    snippets = [];
    const snip = (text) => { snippets.push(text); return snippets.length - 1; };
    const b = st.button;
    const btn = b ? `<button class="btn ${b.primary ? 'primary' : 'light'} small" data-c="${b.act}"${b.text != null ? ` data-snip="${snip(b.text)}"` : ''}${b.href ? ` data-href="${esc(b.href)}"` : ''}>${b.brand ? brandIcon(b.brand, 14) : b.icon ? ic(b.icon, 14) : ''}${esc(b.label)}</button>` : '';
    const ready = st.connected;
    m.innerHTML = `<div class="cx-head"><img src="mascot.svg" alt="" width="30" height="30"><h2>Connect your agent</h2>
        <button class="tb-icon close-x" data-close aria-label="Close">${ic('x', 16)}</button></div>
      <div class="cx">
        <nav class="cx-list">${AGENTS.map((x) => `<button data-agent="${x.id}" class="${x.id === active ? 'on' : ''}"><span class="lg">${logo(x)}</span>${esc(x.name)}${(x.id === 'claude' && s.desktop) || (x.id === 'claudecode' && s.code) ? '<span class="ok-dot" title="Connected"></span>' : ''}</button>`).join('')}</nav>
        <div class="cx-body">
          ${step1()}
          <div class="step${st.connected ? ' done' : ''}"><span class="n">${st.connected ? ic('check', 13) : 2}</span><div><h4>Connect to ${esc(a.name)}</h4>
            <div class="opt"><div class="t"><b>${esc(st.title)}</b><span>${esc(st.sub)}</span></div>${btn}</div>
            ${st.manual?.length ? `<details class="manual"><summary>Or, install manually ${ic('plus', 15)}</summary><div class="in">
              ${st.manual.map(([label, text]) => `<div class="codebox"><div class="cl"><span>${esc(label)}</span><button class="link" data-c="copy" data-snip="${snip(text)}">${ic('copy', 13)} Copy</button></div><pre class="code">${esc(text)}</pre></div>`).join('')}
            </div></details>` : ''}</div></div>
          ${ready || !['claude', 'claudecode'].includes(active) ? `<div class="step"><span class="n">3</span><div><h4>Run your first prompt</h4>
            <p class="hint" style="margin:-4px 0 10px">Try one of these in ${esc(a.name)} to test the connection:</p>
            <div class="prompts">${FIRST_PROMPTS.map((p) => `<button class="prompt-chip" data-c="copy" data-snip="${snip(p)}">${ic('copy', 14)}${esc(p)}</button>`).join('')}</div></div></div>` : ''}
        </div>
      </div>
      <div class="cx-foot"><button class="link" data-c="learn">Learn more</button><button class="btn primary" data-close>Done</button></div>`;
  };
  render();

  m.onclick = async (e) => {
    if (e.target.closest('[data-close]')) return closeModal();
    const ag = e.target.closest('[data-agent]');
    if (ag) { active = ag.dataset.agent; save('agent', active); return render(); }
    const el = e.target.closest('[data-c]');
    if (!el) return;
    const c = el.dataset.c;
    if (c === 'copy-url') copy(url, 'MCP URL copied');
    if (c === 'copy') copy(snippets[Number(el.dataset.snip)]);
    if (c === 'open') { api.openExternal(el.dataset.href); toast('Opening the app… confirm there to finish.'); }
    if (c === 'learn') helpModal();
    if (c === 'desktop') { const r = await run(() => api.connectDesktop()); if (r) { toast(r.note, { ms: 4000 }); connectModal(active); } }
    if (c === 'code') {
      el.disabled = true;
      const r = await run(() => api.connectCode());
      if (r?.ok) { toast(r.note, { ms: 4000 }); connectModal(active); } else { if (r) toast(r.error, { error: true, ms: 6000 }); el.disabled = false; }
    }
  };
}

// ---------- empty editor ----------

function renderEmpty() {
  const e = $('#empty');
  if (state.project && state.page) { e.hidden = true; return; }
  e.hidden = false;
  const p = current();
  e.innerHTML = p ? `<div class="empty-card"><img src="mascot.svg" alt="">
      <h1>${esc(p.name)} has no pages yet</h1>
      <p>Ask your AI to make one, or start a blank page.</p>
      <div class="prompt">Create a landing page in Blobby project “${esc(p.name)}”</div>
      <div class="row"><button class="btn primary" data-empty="new-page">${ic('plus', 15)} New page</button></div></div>` : '';
}

// ---------- creating ----------

async function newProject() {
  const v = await formModal({ title: 'New project', sub: 'One project per client or site. Pages, brand tokens and comments live inside it.', fields: [
    { name: 'name', label: 'Name', placeholder: 'Acme' }, { name: 'site', label: 'Website (optional)', placeholder: 'https://acme.com' }] });
  if (!v || !v.name.trim()) return;
  const p = await run(() => store('createProject', { name: v.name.trim(), site: v.site.trim() }));
  if (p) { await refreshProjects(); goHome(p.slug); }
}

async function newPage(project = state.project) {
  if (!project) return;
  const v = await formModal({ title: 'New page', fields: [{ name: 'name', label: 'Page name', placeholder: 'Landing page' }] });
  if (!v || !v.name.trim()) return;
  const r = await run(() => store('createPage', project, { name: v.name.trim() }));
  if (r) { await refreshProjects(); await openProject(r.project, r.page); }
}

async function doExport(project = state.project, page = state.page) {
  const r = await run(() => api.exportPage(project, page));
  if (r) toast(`Exported to ${r.dir}`, { ms: 4000 });
}

// ---------- keyboard ----------

// One place for app commands: used by keyboard shortcuts, the desktop menu bar and buttons.
// Edit commands fall through to the focused text field when one has focus.
function runCommand(cmd) {
  const t = document.activeElement;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  const inEditor = state.view === 'editor';
  const canvasCenter = () => { const r = $('#canvas').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  if (['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].includes(cmd) && (typing || !inEditor || !$('#modalBack').hidden)) {
    document.execCommand(cmd);
    return true;
  }
  switch (cmd) {
    case 'undo': if (state.page) run(() => store('undo', state.project, state.page), 'Undone'); return true;
    case 'redo': toast('Redo is not supported yet. Ask your AI, or use the page history.'); return true;
    case 'copy': if (state.sel.length) copySelection(); return true;
    case 'cut': if (state.sel.length) copySelection({ cut: true }); return true;
    case 'paste': paste(); return true;
    case 'duplicate': if (inEditor && state.sel.length) duplicateSelection(); return true;
    case 'delete': if (inEditor && state.sel.length) deleteSelected(); return true;
    case 'selectAll': {
      const el = selectedEl();
      if (el) select(siblingsWithId(el).map((n) => n.getAttribute(ID)), state.selDevice);
      else { const doc = docOf(layerDevice()); if (doc) select([...doc.body.children].filter((c) => c.getAttribute(ID)).map((c) => c.getAttribute(ID)), layerDevice()); }
      return true;
    }
    case 'zoomFit': if (inEditor) fit(); return true;
    case 'zoomIn': if (inEditor) zoomAt(...canvasCenter(), 1.2); return true;
    case 'zoomOut': if (inEditor) zoomAt(...canvasCenter(), 1 / 1.2); return true;
    case 'export': if (inEditor && state.page) doExport(); return true;
    case 'newPage': if (state.project || state.homeProject) newPage(state.project || state.homeProject); else newProject(); return true;
    case 'newProject': newProject(); return true;
    case 'toggleLeft': togglePanel('left'); return true;
    case 'toggleRight': togglePanel('right'); return true;
    case 'togglePanels': togglePanel('both'); return true;
    case 'settings': openSettings('general'); return true;
    case 'search': if (state.view === 'home') { state.leftOpen = true; applyPanels(); $('#sideSearch').focus(); $('#sideSearch').select(); } return true;
    case 'shortcuts': shortcutsModal(); return true;
    case 'help': helpModal(); return true;
    case 'connect': connectModal(); return true;
    case 'home': goHome(null); return true;
    case 'comment': openComposer(); return true;
    default: return false;
  }
}

const MOD_KEYS = { z: 'undo', c: 'copy', x: 'cut', v: 'paste', d: 'duplicate', e: 'export', 0: 'zoomFit', '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut', n: 'newPage', ',': 'settings', '/': 'shortcuts', '\\': 'togglePanels', a: 'selectAll', f: 'search' };

function onKey(e) {
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (e.key === 'Escape') { hideMenu(); if (!$('#modalBack').hidden) return closeModal(); }
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && e.altKey && (e.code === 'Digit1' || e.code === 'Digit2')) { e.preventDefault(); runCommand(e.code === 'Digit1' ? 'toggleLeft' : 'toggleRight'); return; }
  if (mod && e.shiftKey && k === 'z') { if (!typing) { e.preventDefault(); runCommand('redo'); } return; }
  if (mod && MOD_KEYS[k] && !e.altKey) {
    // Let text fields keep their own copy/paste/undo/select-all.
    if (typing && ['undo', 'copy', 'cut', 'paste', 'selectAll'].includes(MOD_KEYS[k])) return;
    if (!typing && ['copy', 'cut'].includes(MOD_KEYS[k]) && !state.sel.length) return;
    e.preventDefault();
    runCommand(MOD_KEYS[k]);
    return;
  }
  if (typing || state.view !== 'editor') return;
  if (mod) return;
  const el = selectedEl();
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && el) { e.preventDefault(); moveSibling(e.key === 'ArrowUp' ? -1 : 1); return; }
  if (e.key.startsWith('Arrow') && el && ['absolute', 'fixed'].includes(getComputedStyle(el).position)) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    const cs = getComputedStyle(el);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') applyStyle('left', `${(parseFloat(cs.left) || 0) + (e.key === 'ArrowLeft' ? -d : d)}px`);
    else applyStyle('top', `${(parseFloat(cs.top) || 0) + (e.key === 'ArrowUp' ? -d : d)}px`);
    return;
  }
  if (k === 'v') useTool('select');
  if (k === 'h') useTool('hand');
  if (k === 'p') useTool('interact');
  if (k === 't') insertElement('text');
  if (k === 'r') insertElement('box');
  if (k === 'c') { e.preventDefault(); useTool('comment'); }
  if (e.key === 'Escape') { if (state.commentArm) { state.commentArm = false; renderToolbar(); } else if (el) selectParent(); }
  if (e.key === 'Enter' && el) {
    e.preventDefault();
    if (e.shiftKey) selectParent();
    else { const child = [...el.children].find((c) => c.getAttribute(ID)); if (child) select([child.getAttribute(ID)], state.selDevice); }
  }
  if (e.key === 'Tab' && el) {
    e.preventDefault();
    const sibs = siblingsWithId(el);
    const next = sibs[(sibs.indexOf(el) + (e.shiftKey ? -1 : 1) + sibs.length) % sibs.length];
    select([next.getAttribute(ID)], state.selDevice);
  }
  if ((e.key === 'Backspace' || e.key === 'Delete') && state.sel.length) { e.preventDefault(); deleteSelected(); }
  if (e.key === ' ' && !state.space) { state.space = true; $('#canvas').classList.add('space'); }
}

function setMode(mode) {
  state.mode = mode;
  state.commentArm = false;
  if (mode === 'interact') hoverState = null;
  drawOverlays();
  renderToolbar();
}

// ---------- live updates ----------

let refreshTimer;
let aiTimer;
function bindLive() {
  api.on('store-changed', async ({ paths }) => {
    const mine = (p) => p.startsWith(`${state.project}/`);
    if (state.view === 'editor' && state.page && paths.some((p) => p === `${state.project}/pages/${state.page}.html`)) reloadFrames();
    if (paths.some((p) => mine(p) && p.endsWith('feedback.json'))) loadFeedback();
    let thumbs = false;
    for (const p of paths) {
      const m = p.match(/^([^/]+)\/\.thumbs\/([^/]+)\.jpg$/);
      if (m) { state.thumbVersion[`${m[1]}/${m[2]}`] = (state.thumbVersion[`${m[1]}/${m[2]}`] || 0) + 1; thumbs = true; }
    }
    if (paths.every((p) => p.includes('/.thumbs/'))) { if (thumbs && state.view === 'home') renderDash(); return; }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      const hadPage = state.page;
      await refreshProjects();
      if (state.view === 'editor' && hadPage && !state.page) { renderBoards(); renderLayers(); }
      if (paths.some((p) => mine(p) && (p.endsWith('project.json') || p.includes('/briefs/'))) && !state.sel.length && state.tab === 'inspect' && !panelHasFocus()) renderPanel();
    }, 150);
  });

  api.on('ai-activity', async ({ project, page, tool, user }) => {
    const pill = $('#aiPill');
    $('#aiPillText').textContent = `AI · ${tool.replace(/_/g, ' ')}`;
    pill.hidden = false;
    clearTimeout(aiTimer);
    aiTimer = setTimeout(() => { pill.hidden = true; }, 3500);
    if (!state.follow || !project) return;
    if (state.view !== 'editor' || project !== state.project || (page && page !== state.page)) {
      await refreshProjects();
      await openProject(project, page || undefined);
    }
  });

  api.on('open-page', async ({ project, page }) => {
    await refreshProjects();
    await openProject(project, page);
  });
}

// ---------- wiring ----------

function bindChrome() {
  $('#homeTab').onclick = () => goHome(state.homeSection === 'project' ? state.homeProject : null);
  const tabs = $('#openTabs');
  tabs.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab-project]');
    if (!t) return;
    if (e.target.closest('[data-close-tab]')) closeTab(t.dataset.tabProject, t.dataset.tabPage);
    else openProject(t.dataset.tabProject, t.dataset.tabPage);
  });
  tabs.addEventListener('auxclick', (e) => { const t = e.target.closest('[data-tab-project]'); if (t && e.button === 1) closeTab(t.dataset.tabProject, t.dataset.tabPage); });
  tabs.addEventListener('keydown', (e) => { const t = e.target.closest('[data-tab-project]'); if (t && e.key === 'Enter') openProject(t.dataset.tabProject, t.dataset.tabPage); });
  $('#newTabBtn').onclick = () => {
    const project = state.view === 'editor' ? state.project : state.homeSection === 'project' ? state.homeProject : null;
    if (project) newPage(project); else newProject();
  };
  $('#toggleLeft').onclick = () => togglePanel('left');
  $('#toggleRight').onclick = () => togglePanel('right');
  $('#accountBtn').onclick = (e) => { e.stopPropagation(); if ($('#menu').hidden) accountMenu(); else hideMenu(); };
  $('#meRow').onclick = (e) => { e.stopPropagation(); if ($('#menu').hidden) accountMenu($('#meRow')); else hideMenu(); };
  $('#projBtn').onclick = () => goHome(state.project);
  $('.sidebar').addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]')?.dataset.nav;
    if (!nav) return;
    if (nav === 'recents' || nav === 'projects') { state.search = ''; $('#sideSearch').value = ''; goHome(null, nav); }
    if (nav === 'settings') openSettings();
    if (nav === 'learn') helpModal();
    if (nav === 'shortcuts') shortcutsModal();
    if (nav === 'connect') connectModal();
  });
  $('#sideSearch').addEventListener('input', (e) => {
    state.search = e.target.value;
    if (state.homeSection === 'settings') state.homeSection = 'recents';
    renderDash();
  });
  $('#sideSearch').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; state.search = ''; renderDash(); e.target.blur(); } });
  $('#promo').addEventListener('click', (e) => {
    const act = e.target.closest('[data-promo]')?.dataset.promo;
    if (act === 'hide') { state.promoHidden = true; save('promoHidden', true); renderPromo(); }
    if (act === 'connect') connectModal();
  });
  $('#rail').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) useTool(b.dataset.tool);
    if (b.dataset.insert) insertElement(b.dataset.insert);
  });
  $('#projectList').addEventListener('click', (e) => { const b = e.target.closest('[data-project]'); if (b) { state.search = ''; $('#sideSearch').value = ''; goHome(b.dataset.project); } });
  $('#projectList').addEventListener('contextmenu', (e) => { const b = e.target.closest('[data-project]'); if (b) { e.preventDefault(); projectMenu(b.dataset.project, e.clientX, e.clientY); } });
  $('#pageList').addEventListener('click', (e) => { const b = e.target.closest('[data-page]'); if (b) openProject(state.project, b.dataset.page); });
  $('#pageList').addEventListener('contextmenu', (e) => { const b = e.target.closest('[data-page]'); if (b) { e.preventDefault(); pageMenu(state.project, b.dataset.page, e.clientX, e.clientY); } });
  $('#pageList').addEventListener('dblclick', (e) => { const b = e.target.closest('[data-page]'); if (b) pageMenu(state.project, b.dataset.page, e.clientX, e.clientY); });
  $('#newProjectBtn').onclick = newProject;
  $('#newPageBtn').onclick = () => newPage();
  $('#revealBtn').onclick = () => api.reveal?.(state.project);
  $('#exportBtn').onclick = () => doExport();
  $('#connectBtn').onclick = () => connectModal();
  $('#zoomBtn').onclick = (e) => { e.stopPropagation(); if ($('#menu').hidden) zoomMenu(); else hideMenu(); };
  $('#followAi').onchange = (e) => { state.follow = e.target.checked; save('follow', state.follow); };
  document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
  $('#empty').addEventListener('click', (e) => { if (e.target.closest('[data-empty="new-page"]')) newPage(); });

  const dash = $('#dash');
  dash.addEventListener('click', (e) => {
    const t = e.target;
    const pm = t.closest('[data-project-menu]');
    if (pm) { e.stopPropagation(); const r = pm.getBoundingClientRect(); return projectMenu(pm.dataset.projectMenu, r.left, r.bottom + 4); }
    const gm = t.closest('[data-page-menu]');
    if (gm) { e.stopPropagation(); const r = gm.getBoundingClientRect(); return pageMenu(gm.dataset.project, gm.dataset.pageMenu, r.left, r.bottom + 4); }
    const vt = t.closest('[data-view]');
    if (vt) { state.dashView = vt.dataset.view; save('dashView', state.dashView); return renderDash(); }
    const np = t.closest('[data-new-page]');
    if (np) return newPage(np.dataset.newPage);
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'new-project') return newProject();
    if (act === 'connect') return connectModal();
    const open = t.closest('[data-open-page]');
    if (open) return openProject(open.dataset.openProject, open.dataset.openPage);
    const hp = t.closest('[data-home-project]');
    if (hp) { state.search = ''; return goHome(hp.dataset.homeProject); }
  });
  dash.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('.card, .rowi')) e.target.click(); });
  dash.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card[data-open-page], .card[data-home-project], .rowi[data-open-page], .rowi[data-home-project]');
    if (!card) return;
    e.preventDefault();
    if (card.dataset.openPage) pageMenu(card.dataset.openProject, card.dataset.openPage, e.clientX, e.clientY);
    else projectMenu(card.dataset.homeProject, e.clientX, e.clientY);
  });

  $('#modalBack').addEventListener('mousedown', (e) => { if (e.target.id === 'modalBack') closeModal(); });
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('#menu, #accountBtn, #meRow, #zoomBtn')) hideMenu(); });
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', (e) => { if (e.key === ' ') { state.space = false; $('#canvas').classList.remove('space'); } });
}

async function init() {
  $('#app').classList.add('platform-desktop', IS_MAC ? 'os-mac' : 'os-other');
  watchKeyLabels();
  fillIcons();
  applyPanels();
  state.appInfo = await api.appInfo?.().catch(() => null) || null;
  api.on('menu', (cmd) => runCommand(cmd));
  bindChrome();
  bindCanvas();
  bindPanel();
  bindLayers();
  bindLive();
  renderToolbar();
  renderAccount();
  await refreshProjects();
  const last = saved('last', null);
  if (last?.view === 'editor' && state.projects.some((p) => p.slug === last.project)) await openProject(last.project, last.page);
  else goHome(last?.homeProject && state.projects.some((p) => p.slug === last.homeProject) ? last.homeProject : null);
}

init();
