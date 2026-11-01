// Research helpers behind the MCP tools: free image search, real company logos, downloads and
// design playbooks. Runs in Node, so none of it needs the app. No API keys needed; a Pexels key
// (PEXELS_API_KEY or "pexelsKey" in ~/Blobby/.config.json) adds Pexels photos to image search.

import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import * as store from '../shared/store.js';

const BOT_UA = 'Blobby/0.2 (+https://github.com/Ravindrabisht12/blobby)';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const SIMPLE_ICONS = 'https://cdn.jsdelivr.net/npm/simple-icons@16.36.0/icons';
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif', 'image/avif': 'avif', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico' };
export const IMAGE_FILE = /\.(jpe?g|png|webp|gif|svg|avif)$/i;

async function get(url, { headers = {}, timeout = 12000, ua = BOT_UA } = {}) {
  const res = await fetch(url, { headers: { 'user-agent': ua, ...headers }, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).hostname}`);
  return res;
}

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

function config() {
  try { return JSON.parse(fs.readFileSync(path.join(store.root(), '.config.json'), 'utf8')); } catch { return {}; }
}

// Downloads an image into the project's assets. Returns { path, file } like store.addAsset.
export async function downloadAsset(project, url, filename) {
  const res = await get(url, { ua: BROWSER_UA, timeout: 20000 });
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  const buf = Buffer.from(await res.arrayBuffer());
  let name = filename || decodeURIComponent(new URL(url).pathname.split('/').pop() || 'asset');
  name = name.replace(/\.\w{2,5}$/, '') + '.' + (IMAGE_EXT[type] || (name.match(/\.(\w{2,5})$/) || [])[1] || 'jpg');
  return store.addAsset(project, { filename: name, data: buf.toString('base64') });
}

// ---------- image search ----------

const fitsOrientation = (w, h, orientation) => {
  if (!orientation || !w || !h) return true;
  const r = w / h;
  return orientation === 'landscape' ? r > 1.15 : orientation === 'portrait' ? r < 0.87 : r >= 0.87 && r <= 1.15;
};

async function pexels(query, count, orientation, key) {
  const u = new URL('https://api.pexels.com/v1/search');
  u.searchParams.set('query', query);
  u.searchParams.set('per_page', String(count));
  if (orientation) u.searchParams.set('orientation', orientation);
  const d = await (await get(u, { headers: { authorization: key } })).json();
  return (d.photos || []).map((p) => ({
    source: 'Pexels', title: p.alt || query, url: p.src.large2x, thumb: p.src.medium, width: p.width, height: p.height,
    license: 'Pexels License (free, no attribution required)', credit: `Photo by ${p.photographer} on Pexels`, page: p.url,
  }));
}

async function openverse(query, count, orientation) {
  const u = new URL('https://api.openverse.org/v1/images/');
  u.searchParams.set('q', query);
  u.searchParams.set('page_size', String(Math.min(20, count * 2)));
  u.searchParams.set('license_type', 'commercial,modification');
  const ar = { landscape: 'wide', portrait: 'tall', square: 'square' }[orientation];
  if (ar) u.searchParams.set('aspect_ratio', ar);
  const d = await (await get(u, { timeout: 9000 })).json();
  return (d.results || []).filter((r) => !r.width || r.width >= 900).map((r) => ({
    source: 'Openverse', title: r.title || query, url: r.url, thumb: r.thumbnail, width: r.width, height: r.height,
    license: `${String(r.license || '').toUpperCase()} ${r.license_version || ''}`.trim(), credit: r.attribution || `${r.title} by ${r.creator}`, page: r.foreign_landing_url,
  }));
}

async function commons(query, count, orientation) {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  const params = {
    action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrsearch: `${query} filetype:bitmap`,
    gsrlimit: String(Math.min(50, count * 5)), prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '480',
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const d = await (await get(u)).json();
  return Object.values(d.query?.pages || {}).sort((a, b) => a.index - b.index).map((p) => ({ p, ii: p.imageinfo?.[0] }))
    .filter(({ ii }) => ii && /jpeg|png|webp/.test(ii.mime) && ii.width >= 1000 && fitsOrientation(ii.width, ii.height, orientation))
    .map(({ p, ii }) => {
      const meta = ii.extmetadata || {};
      const license = stripTags(meta.LicenseShortName?.value) || 'see page';
      return {
        // Originals can be 10,000px+; a 2000px rendition is plenty for the web.
        source: 'Wikimedia Commons', title: p.title.replace(/^File:/, '').replace(/\.\w+$/, ''),
        url: ii.width > 2000 && ii.thumburl ? ii.thumburl.replace(/\/\d+px-/, '/2000px-') : ii.url, thumb: ii.thumburl,
        width: ii.width, height: ii.height, license, credit: `${stripTags(meta.Artist?.value) || 'Unknown author'}, ${license}, via Wikimedia Commons`, page: ii.descriptionurl,
      };
    })
    .filter((x) => !/fair use|non-free/i.test(x.license));
}

export async function findImages({ query, count = 8, orientation }) {
  const key = process.env.PEXELS_API_KEY || config().pexelsKey;
  const sources = [
    ...(key ? [['Pexels', () => pexels(query, count, orientation, key)]] : []),
    ['Openverse', () => openverse(query, count, orientation)],
    ['Wikimedia Commons', () => commons(query, count, orientation)],
  ];
  const results = [];
  const notes = [];
  for (const [name, fn] of sources) {
    if (results.length >= count) break;
    try { results.push(...(await fn()).slice(0, count - results.length)); } catch (err) { notes.push(`${name}: ${err.message}`); }
  }
  if (!key) notes.push('Tip: add a free Pexels API key (PEXELS_API_KEY, or "pexelsKey" in ~/Blobby/.config.json) for better photography.');
  return { results: results.map((r, i) => ({ n: i + 1, ...r })), notes };
}

// ---------- logos ----------

const iconSlug = (name) => String(name).toLowerCase().replace(/\+/g, 'plus').replace(/\./g, 'dot').replace(/&/g, 'and')
  .normalize('NFD').replace(/[^a-z0-9]/g, '');
const bareDomain = (d) => String(d).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

function cleanSvg(svg, color) {
  let out = svg.trim();
  if (!/xmlns=/.test(out)) out = out.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  // One color for the whole mark (e.g. a grey logo strip): every non-"none" fill/stroke becomes it.
  if (color) {
    out = out.replace(/\s(fill|stroke)="(?!none)[^"]*"/g, ` $1="${color}"`);
    if (!/^<svg[^>]*\sfill=/.test(out)) out = out.replace(/^<svg/, `<svg fill="${color}"`);
  }
  return out;
}

// The logo a company shows in its own site header: usually the full wordmark. Skips marks that are
// labelled as some other company (customer logo strips use the same "logo" class names).
async function siteLogo(domain, name) {
  const base = `https://${bareDomain(domain)}/`;
  const html = await (await get(base, { ua: BROWSER_UA })).text();
  const { document } = parseHTML(html);
  const all = (sel) => { try { return [...document.querySelectorAll(sel)]; } catch { return [...document.querySelectorAll(sel.replace(/ i\]/g, ']'))]; } };
  const want = [iconSlug(name), iconSlug(bareDomain(domain).split('.')[0])];
  const labels = (el) => [el.getAttribute('aria-label'), el.querySelector?.('title')?.textContent, el.getAttribute('alt'), el.closest('a')?.getAttribute('aria-label'), el.closest('a')?.getAttribute('title')].filter(Boolean);
  const exact = (el) => labels(el).some((l) => want.includes(iconSlug(l).replace(/^(logo|home)|(logo|home|homepage)$/g, '')));
  const wide = (el) => { const vb = (el.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number); return vb.length === 4 && vb[2] / vb[3] > 2; };
  const ok = (el) => {
    if (el.closest('[class*="customer"], [class*="client"], [class*="partner"], [class*="testimonial"], [class*="case-stud"], footer')) return false;
    const label = labels(el).join(' ');
    const slug = iconSlug(label);
    return !slug || want.some((w) => w && slug.includes(w)) || /logo|home/i.test(label);
  };
  const home = 'a[href="/"], a[href="./"], a[href="' + base + '"]';
  const svgs = [`header :is(${home}) svg`, `nav :is(${home}) svg`, `:is(${home}) svg`, 'header [class*="logo" i] svg', '[class*="logo" i] svg']
    .flatMap(all).filter((el) => ok(el) && !el.querySelector('use') && el.outerHTML.length < 80000 && el.querySelector('path, polygon, rect, circle, g'));
  const svg = svgs.find((el) => exact(el) && wide(el)) || svgs.find(exact) || svgs.find((el) => !labels(el).length);
  if (svg) return { svg: svg.outerHTML, from: 'site header (svg)' };
  // Labelled with the name plus other words (e.g. "Acme Events logo"): only a last resort.
  if (svgs[0]) return { svg: svgs[0].outerHTML, from: `site (svg labelled "${labels(svgs[0])[0]}")`, partial: true };
  for (const sel of [`header :is(${home}) img`, `:is(${home}) img`, 'header img[src*="logo" i]', 'img[class*="logo" i]', '[class*="logo" i] img', 'img[alt*="logo" i]', 'img[src*="logo" i]']) {
    const img = all(sel).find((el) => ok(el) && el.getAttribute('src') && !el.getAttribute('src').startsWith('data:'));
    if (img) return { url: new URL(img.getAttribute('src'), base).href, from: 'site header (image)' };
  }
  const icon = all('link[rel="icon"][type="image/svg+xml"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]')[0];
  if (icon?.getAttribute('href')) return { url: new URL(icon.getAttribute('href'), base).href, from: 'site icon (square mark, not a wordmark)' };
  return null;
}

async function simpleIcon(names) {
  for (const slug of [...new Set(names.map(iconSlug).filter(Boolean))]) {
    try {
      const svg = await (await get(`${SIMPLE_ICONS}/${slug}.svg`)).text();
      if (svg.startsWith('<svg')) return svg;
    } catch { /* try the next name */ }
  }
  return null;
}

// companies: [{ name, domain? }]. Saves each logo into the project's assets.
export async function findLogos(project, companies, { color, prefer = 'wordmark' } = {}) {
  const out = [];
  for (const c of companies) {
    const name = c.name || bareDomain(c.domain || '');
    const file = `logo-${store.slugify(name)}`;
    const domain = c.domain ? bareDomain(c.domain) : null;
    const tried = [];
    let saved = null;
    const fromIcons = async () => {
      const svg = await simpleIcon([name, domain && domain.split('.')[0]].filter(Boolean));
      if (!svg) { tried.push('Simple Icons: no match'); return null; }
      return { ...store.addAsset(project, { filename: `${file}.svg`, data: Buffer.from(cleanSvg(svg, color)).toString('base64') }), source: 'Simple Icons (brand mark, CC0 icon data)', kind: 'mark' };
    };
    const fromSite = async () => {
      if (!domain) { tried.push('site: no domain given'); return null; }
      try {
        const found = await siteLogo(domain, name);
        if (!found) { tried.push(`site: no logo found on ${domain}`); return null; }
        if (found.svg) {
          const fills = [...found.svg.matchAll(/fill="([^"]+)"/g)].map((m) => m[1].toLowerCase()).filter((f) => f !== 'none');
          const white = !color && fills.length && fills.every((f) => /^(#fff|#ffffff|white)$/.test(f));
          return { ...store.addAsset(project, { filename: `${file}.svg`, data: Buffer.from(cleanSvg(found.svg, color)).toString('base64') }), source: `${domain} ${found.from}`, kind: 'wordmark', partial: found.partial, ...(white ? { note: 'White logo: use it on a dark background, or call again with color.' } : {}) };
        }
        return { ...(await downloadAsset(project, found.url, file)), source: `${domain} ${found.from}`, kind: /icon/.test(found.from) ? 'mark' : 'wordmark' };
      } catch (err) { tried.push(`site: ${err.message}`); return null; }
    };
    let partial = null;
    for (const step of prefer === 'mark' ? [fromIcons, fromSite] : [fromSite, fromIcons]) {
      saved = await step();
      if (saved?.partial) { partial = saved; saved = null; continue; }
      if (saved) break;
    }
    if (!saved && partial) saved = partial;
    if (saved) delete saved.partial;
    out.push(saved ? { name, ...saved } : { name, error: `No logo found (${tried.join('; ')}). Pass the company's domain, or ask the user for the logo file.` });
  }
  return out;
}

// ---------- design playbooks ----------

const AVOID = [
  'Grey or flat boxes where a photo should be. Every image slot gets a real image (brand site, owner photos, find_images) or deliberate art.',
  'Logo strips written as plain text. Use find_logos or the logoClouds from analyze_site.',
  'The default "AI landing page": centered hero + three identical icon cards + gradient blob + generic "Unlock your potential" copy.',
  'Emoji as icons, random gradients, purple-blue defaults, and stock phrases ("seamless", "elevate", "unleash", "revolutionize").',
  'Invented facts. Numbers, awards, quotes and client names come from research or are clearly marked as examples to replace.',
  'Inline style="" attributes. Write classes in set_css; small tweaks with update_styles.',
];

const PLAYBOOKS = {
  'personal-brand': {
    for: 'Athletes, creators, influencers, coaches, artists, public figures',
    research: ['analyze_social on every handle the user gives (Instagram, YouTube, X, TikTok, Linktree): real name, bio, follower counts, links, photos', 'Ask for (or import with add_asset folder) 8-15 of their best photos if the profile hides posts behind a login', 'Study 2-3 official sites of well-known people in the same field (search "<field> official website") for structure, not branding'],
    sections: ['Full-bleed hero: a big real portrait or action photo, name as the headline, one-line identity ("Fast bowler · Mumbai Indians"), follow / contact CTA', 'Proof strip: real numbers (followers, matches, wins, records), each with a label', 'Story / about: short first-person bio with a second photo', 'Highlights: photo grid or reel of real posts with captions (link each to the post)', 'Achievements / timeline or Featured in (real press logos)', 'Partners / sponsors (real logos via find_logos), only ones that are real', 'Contact / bookings: email, management, socials with real handles and follower counts'],
    imagery: 'Their own photos first: action shots for hero, candid ones for story. Crop with object-fit: cover and a consistent aspect ratio per row. Never stock photos of strangers as "them".',
    type: 'Strong condensed or editorial display face for the name (e.g. "Anton", "Bebas Neue", "Oswald", "Archivo Black", "Fraunces") with a clean sans for text.',
    color: 'Take it from their content: team colors, a recurring color in their photos, or their profile picture. Dark, high-contrast themes suit sport.',
    signature: ['Oversized name type over or beside the photo', 'Stat counters with real numbers', 'Horizontal scroll of posts', 'Social follow buttons that show real counts'],
  },
  saas: {
    for: 'Software products, apps, developer tools, AI products',
    research: ['analyze_site the product site (if it exists) and pass project so logos and customer logo strips are saved', 'Study 2-3 category leaders, e.g. linear.app, stripe.com, vercel.com, for section rhythm'],
    sections: ['Hero: specific promise + real product UI (screenshot or crafted HTML mock of the actual UI) + primary CTA', 'Customer logo strip (real logos)', 'Problem → how it works (3 steps with UI crops)', 'Feature deep-dives: alternating text / product visual rows, not identical cards', 'Proof: metrics, testimonial with real name, photo and company', 'Pricing or integration grid (real logos)', 'Final CTA'],
    imagery: 'Product UI is the hero image. Build it as HTML (real-looking app chrome, real data) when no screenshot exists. Never a grey rectangle labelled "screenshot".',
    type: 'One crisp sans (Inter, Geist, "Instrument Sans", "Manrope") with tight display tracking; monospace accents for technical products.',
    color: 'Brand primary used sparingly for CTAs and highlights on a calm neutral base.',
    signature: ['UI crops with subtle shadows and real data', 'Logo strip in grayscale', 'Code or terminal snippets for developer products'],
  },
  ecommerce: {
    for: 'Online stores, DTC brands, product launches',
    research: ['analyze_site the store with project set: real product photos, logo, prices, copy', 'Study allbirds.com, aesop.com or glossier.com for product storytelling'],
    sections: ['Hero: lifestyle or product photo, offer, Shop CTA', 'Best sellers grid with real photos, names and prices', 'Brand story / ingredients / craft with photography', 'Reviews with stars and real counts', 'Press logos', 'Guarantee / shipping / returns strip', 'Newsletter'],
    imagery: 'Only the brand\'s real product photos for products. Lifestyle shots from find_images are fine for mood, never for the product itself.',
    type: 'Brand-led; often an elegant serif display with a neutral sans.',
    color: 'From the packaging and photography.',
    signature: ['Consistent product card ratios', 'Hover second image', 'Price and rating on every card'],
  },
  local: {
    for: 'Restaurants, cafes, gyms, clinics, salons, trades, local services',
    research: ['analyze_site their current site and Google/Instagram profile with analyze_social: photos, menu/services, hours, address, reviews', 'Ask the user for photos if there are none online'],
    sections: ['Hero: real photo of the place/food/team + what, where + Book/Call CTA', 'Services or menu highlights with prices', 'Photos (gallery)', 'Reviews (real, with source)', 'Hours, map and address', 'Contact / booking'],
    imagery: 'Their real place, food and people. Stock only for texture.',
    type: 'Character fits the place: warm serif for food, bold sans for fitness, calm sans for clinics.',
    color: 'From their signage, interior or logo.',
    signature: ['Sticky Call/Book button on mobile', 'Opening hours that are easy to scan', 'Click-to-call phone links'],
  },
  portfolio: {
    for: 'Agencies, studios, designers, photographers, freelancers',
    research: ['analyze_site / analyze_social for their real work images and client list', 'Study pentagram.com and strong studio sites for restraint and grid'],
    sections: ['Hero: positioning line + one standout project image', 'Selected work grid (real project images, client, discipline)', 'Clients (real logos)', 'Services', 'About / team with photos', 'Contact'],
    imagery: 'Their work is the design. Large images, generous whitespace.',
    type: 'Confident, minimal; one family in two or three weights.',
    color: 'Mostly neutral so the work carries the color.',
    signature: ['Asymmetric editorial grid', 'Case study cards with hover reveal'],
  },
  event: {
    for: 'Conferences, meetups, tournaments, launches, weddings',
    research: ['Gather date, venue, speakers/teams/lineup, tickets and sponsors from the user or the event\'s existing pages', 'Speaker/team photos and sponsor logos (find_logos)'],
    sections: ['Hero: name, date, place, ticket CTA, countdown', 'Lineup / speakers with real photos', 'Schedule', 'Venue with map', 'Sponsors (real logos)', 'FAQ', 'Tickets'],
    imagery: 'Real people and venue. Past-event photos if available.',
    type: 'Expressive display face for the event name.',
    color: 'From the event identity.',
    signature: ['Date and venue always visible near the CTA', 'Schedule as tabs per day'],
  },
};

export function playbook(kind) {
  const key = Object.keys(PLAYBOOKS).find((k) => k === kind) || null;
  return {
    avoid: AVOID,
    ...(key ? { type: key, ...PLAYBOOKS[key] } : { types: Object.fromEntries(Object.entries(PLAYBOOKS).map(([k, v]) => [k, v.for])), note: 'Pass one of these types for its full playbook.' }),
  };
}

export const PLAYBOOK_TYPES = Object.keys(PLAYBOOKS);
